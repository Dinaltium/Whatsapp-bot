import { Pool } from "pg";
import jwt from "jsonwebtoken";
import {
  initAuthCreds,
  BufferJSON,
  AuthenticationState,
  AuthenticationCreds,
} from "@whiskeysockets/baileys";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const AUTH_TABLE = "wa_auth_state";
const DEFAULT_NAMESPACE = "parag";

interface StorageValue {
  [key: string]: any;
}

interface AuthStateStore {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  close?: () => Promise<void>;
}

function getDatabaseUrl(): string | null {
  return process.env.DATABASE_URL || process.env.NEON_DATABASE_URL || null;
}

function getJwtSecret(): string | null {
  return process.env.AUTH_STATE_JWT_SECRET || null;
}

function getEncryptionKey(): Buffer | null {
  const secret = process.env.AUTH_STATE_KEY || process.env.AUTH_STATE_JWT_SECRET || null;
  if (!secret) return null;
  return scryptSync(secret, "dk24_auth_salt", 32);
}

function serializeStateValue(value: StorageValue): string {
  const json = JSON.stringify(value, BufferJSON.replacer);
  const key = getEncryptionKey();

  if (!key) {
    throw new Error(
      "FATAL: Both AUTH_STATE_KEY and AUTH_STATE_JWT_SECRET are missing. Authentication state MUST be encrypted in production."
    );
  }

  const iv = randomBytes(12); // 12-byte IV for AES-GCM
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(json, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");

  return `enc:${iv.toString("hex")}:${tag}:${encrypted}`;
}

function deserializeStateValue(raw: string): StorageValue {
  if (!raw) return null as any;

  if (raw.startsWith("enc:")) {
    const key = getEncryptionKey();
    if (!key) {
      throw new Error(
        "AUTH_STATE_KEY or AUTH_STATE_JWT_SECRET is required to decrypt auth state.",
      );
    }
    const parts = raw.split(":");
    const iv = Buffer.from(parts[1], "hex");
    const tag = Buffer.from(parts[2], "hex");
    const encrypted = parts[3];

    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return JSON.parse(decrypted, BufferJSON.reviver);
  }

  if (raw.startsWith("jwt:")) {
    const token = raw.slice(4);
    const secret = getJwtSecret();
    if (!secret) {
      throw new Error(
        "AUTH_STATE_JWT_SECRET is required to read legacy JWT-wrapped auth state.",
      );
    }

    const decoded = jwt.verify(token, secret, { algorithms: ["HS256"] }) as {
      data: string;
    };
    return JSON.parse(decoded.data, BufferJSON.reviver);
  }

  const payload = raw.startsWith("json:") ? raw.slice(5) : raw;
  return JSON.parse(payload, BufferJSON.reviver);
}

function buildStorageKey(
  namespace: string,
  kind: string,
  type?: string,
  id?: string,
): string {
  if (kind === "creds") {
    return `${namespace}:creds`;
  }

  return `${namespace}:key:${type}:${id}`;
}

async function ensureSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${AUTH_TABLE} (
      id TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function readOne(pool: Pool, id: string): Promise<StorageValue> {
  const result = await pool.query(
    `SELECT value FROM ${AUTH_TABLE} WHERE id = $1 LIMIT 1`,
    [id],
  );

  if (!result.rows.length) {
    return null as any;
  }

  return deserializeStateValue(result.rows[0].value);
}

async function upsertOne(
  pool: Pool,
  id: string,
  value: StorageValue,
): Promise<void> {
  const encoded = serializeStateValue(value);

  await pool.query(
    `
      INSERT INTO ${AUTH_TABLE} (id, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (id)
      DO UPDATE SET
        value = EXCLUDED.value,
        updated_at = NOW()
    `,
    [id, encoded],
  );
}

async function deleteMany(pool: Pool, ids: string[]): Promise<void> {
  if (!ids.length) return;

  await pool.query(`DELETE FROM ${AUTH_TABLE} WHERE id = ANY($1::text[])`, [
    ids,
  ]);
}

/**
 * Bulk-upsert all entries in a single query using unnest().
 * This is critical for performance: during the WhatsApp handshake,
 * keys.set() can be called with 100+ pre-keys simultaneously.
 * Promise.all(N individual upserts) would exhaust a small pool instantly.
 * One query with two unnest arrays is a single round-trip regardless of N.
 */
async function upsertMany(
  pool: Pool,
  entries: Array<{ id: string; value: StorageValue }>,
): Promise<void> {
  if (!entries.length) return;

  const ids: string[] = [];
  const encodedValues: string[] = [];

  for (const { id, value } of entries) {
    ids.push(id);
    encodedValues.push(serializeStateValue(value));
  }

  await pool.query(
    `INSERT INTO ${AUTH_TABLE} (id, value, updated_at)
     SELECT unnest($1::text[]), unnest($2::text[]), NOW()
     ON CONFLICT (id)
     DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [ids, encodedValues],
  );
}

async function readMany(
  pool: Pool,
  ids: string[],
): Promise<Map<string, StorageValue>> {
  if (!ids.length) return new Map();

  const result = await pool.query(
    `SELECT id, value FROM ${AUTH_TABLE} WHERE id = ANY($1::text[])`,
    [ids],
  );

  const mapped = new Map<string, StorageValue>();
  for (const row of result.rows) {
    mapped.set(row.id, deserializeStateValue(row.value));
  }

  return mapped;
}

async function useNeonAuthState(
  namespace = DEFAULT_NAMESPACE,
  existingPool: Pool | null = null,
): Promise<AuthStateStore> {
  if (!getEncryptionKey()) {
    throw new Error(
      "FATAL: Both AUTH_STATE_KEY and AUTH_STATE_JWT_SECRET are missing. Authentication state MUST be encrypted in production. Please set AUTH_STATE_KEY in your environment."
    );
  }

  let pool: Pool;
  let ownsPool = false;

  if (existingPool) {
    pool = existingPool;
  } else {
    const databaseUrl = getDatabaseUrl();

    if (!databaseUrl) {
      throw new Error(
        "DATABASE_URL (or NEON_DATABASE_URL) is required for Neon auth storage.",
      );
    }

    // Dedicated pool just for auth state — isolated from the app pool so that
    // long-running app queries (allowlist loads, schema migrations, etc.) can
    // never starve the auth pool during the WhatsApp handshake.
    pool = new Pool({
      connectionString: databaseUrl,
      max: 1, // auth state is sequential; one connection is enough
      connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS || 30000),
      idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 120000),
      // TCP keepalive prevents Neon from silently terminating idle connections
      // between bot restarts and the WhatsApp handshake.
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
      ssl:
        process.env.DATABASE_SSL === "false"
          ? false
          : {
              rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false",
            },
    });
    ownsPool = true;

    pool.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`⚠️ Neon pool error: ${message}`);
    });
  }

  // Pending writes queue (id -> value) and flusher state
  const pendingWrites = new Map<string, StorageValue>();
  let flushTimer: NodeJS.Timeout | null = null;
  const FLUSH_INTERVAL_MS = Number(process.env.DB_FLUSH_INTERVAL_MS || 5000);


  async function flushPendingWrites(): Promise<void> {
    if (!pendingWrites.size) return;

    const toUpsert: Array<{ id: string; value: StorageValue }> = [];
    const toDelete: string[] = [];

    for (const [id, value] of pendingWrites.entries()) {
      if (value === null) {
        toDelete.push(id);
      } else {
        toUpsert.push({ id, value });
      }
    }

    try {
      if (toUpsert.length) await upsertMany(pool, toUpsert);
      if (toDelete.length) await deleteMany(pool, toDelete);
      pendingWrites.clear();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`⚠️ Failed flushing pending auth writes: ${message}`);
      // keep all entries — they'll be retried on the next flush interval
    }

    if (pendingWrites.size === 0 && flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
  }

  function ensureFlushTimer(): void {
    if (flushTimer) return;
    flushTimer = setInterval(() => {
      // fire-and-forget
      flushPendingWrites().catch(() => undefined);
    }, FLUSH_INTERVAL_MS);
  }

  await ensureSchema(pool);

  const credsKey = buildStorageKey(namespace, "creds");
  const creds = (await readOne(pool, credsKey)) || initAuthCreds();

  const state: AuthenticationState = {
    creds: creds as AuthenticationCreds,
    keys: {
      get: async (type: string, ids: string[]) => {
        try {
          const keyIds = ids.map((id) =>
            buildStorageKey(namespace, "key", type, id),
          );
          const rows = await readMany(pool, keyIds);
          const data: any = {};

          ids.forEach((id) => {
            const dbKey = buildStorageKey(namespace, "key", type, id);
            const value = rows.get(dbKey);
            if (value) data[id] = value;
          });

          return data;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.warn(`⚠️ Failed to read auth keys from Neon: ${message}`);
          return {};
        }
      },
      set: async (data: any) => {
        // Collect all writes first, then issue a SINGLE bulk upsert.
        // Promise.all(N individual upserts) would saturate a small pool when
        // WhatsApp sends 100+ pre-keys during the initial handshake.
        const toUpsert: Array<{ id: string; value: StorageValue }> = [];
        const deletions: string[] = [];

        for (const [typeKey, typeData] of Object.entries(data)) {
          for (const [id, value] of Object.entries(typeData as any)) {
            const dbKey = buildStorageKey(namespace, "key", typeKey, id);
            if (value) {
              toUpsert.push({ id: dbKey, value: value as StorageValue });
            } else {
              deletions.push(dbKey);
            }
          }
        }

        try {
          if (toUpsert.length) await upsertMany(pool, toUpsert);
          if (deletions.length) await deleteMany(pool, deletions);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.warn(`⚠️ Failed to persist auth keys to Neon: ${message}`);
          // Queue all failed writes for background retry
          for (const { id, value } of toUpsert) {
            pendingWrites.set(id, value);
          }
          for (const id of deletions) {
            pendingWrites.set(id, null as any);
          }
          ensureFlushTimer();
        }
      },
    } as any,
  };

  const saveCreds = async () => {
    try {
      await upsertOne(pool, credsKey, creds);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`⚠️ Failed to persist auth creds to Neon: ${message}`);
      // queue and ensure background flusher runs
      pendingWrites.set(credsKey, creds as StorageValue);
      ensureFlushTimer();
    }
  };

  return {
    state,
    saveCreds,
    close: async () => {
      try {
        await flushPendingWrites();
      } catch (error) {
        // ignore flush errors on shutdown
      }

      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
      }

      if (ownsPool && pool) {
        await pool.end();
      }
    },
  };
}

export { useNeonAuthState, getDatabaseUrl };
