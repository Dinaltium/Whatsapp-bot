import { Pool } from "pg";
import {
  AuthenticationState,
  AuthenticationCreds,
  initAuthCreds,
  BufferJSON,
} from "@whiskeysockets/baileys";
import format from "pg-format";
import "dotenv/config";

const AUTH_TABLE = "wa_auth_state";
const DEFAULT_NAMESPACE = "parag";

export function getDatabaseUrl(): string | undefined {
  return process.env.DATABASE_URL || process.env.NEON_DATABASE_URL;
}

type StorageValue = any;

function serializeStateValue(value: StorageValue): string {
  return JSON.stringify(value, BufferJSON.replacer);
}

function deserializeStateValue(value: string | null): StorageValue {
  if (!value) return null;
  return JSON.parse(value, BufferJSON.reviver);
}

function buildStorageKey(
  namespace: string,
  type: string,
  subtype?: string,
  id?: string,
): string {
  return [namespace, type, subtype, id].filter(Boolean).join(":");
}

async function ensureSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${AUTH_TABLE} (
      id TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
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

// Replaces 100 concurrent queries with 1 single bulk insert query.
// This is critical to prevent connection exhaustion in serverless Postgres.
async function upsertMany(
  pool: Pool,
  writes: { id: string; value: StorageValue }[],
): Promise<void> {
  if (writes.length === 0) return;

  const values = writes.map((w) => [w.id, serializeStateValue(w.value)]);
  const query = format(
    `INSERT INTO ${AUTH_TABLE} (id, value) 
     VALUES %L 
     ON CONFLICT (id) DO UPDATE SET 
       value = EXCLUDED.value, 
       updated_at = NOW()`,
    values,
  );

  await pool.query(query);
}

async function deleteMany(pool: Pool, ids: string[]): Promise<void> {
  if (!ids.length) return;

  await pool.query(`DELETE FROM ${AUTH_TABLE} WHERE id = ANY($1::text[])`, [
    ids,
  ]);
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

export async function useNeonAuthState(
  namespace = DEFAULT_NAMESPACE,
): Promise<any> {
  const databaseUrl = getDatabaseUrl();

  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL (or NEON_DATABASE_URL) is required for Neon auth storage.",
    );
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1, // Only 1 connection needed for auth state
    // Set extremely low idle timeout. If the connection sits idle, close it immediately.
    // This prevents pg-pool from trying to use a connection that Neon has silently dropped,
    // which results in the 'timeout exceeded when trying to connect' error.
    idleTimeoutMillis: 1000,
    connectionTimeoutMillis: 15000, // 15 seconds to connect
    ssl:
      process.env.DATABASE_SSL === "false"
        ? false
        : {
            rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false",
          },
  });

  pool.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️ Neon pool error: ${message}`);
  });

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
        try {
          const writes: { id: string; value: StorageValue }[] = [];
          const deletions: string[] = [];

          for (const [typeKey, typeData] of Object.entries(data)) {
            for (const [id, value] of Object.entries(typeData as any)) {
              const dbKey = buildStorageKey(namespace, "key", typeKey, id);
              if (value) {
                writes.push({ id: dbKey, value });
              } else {
                deletions.push(dbKey);
              }
            }
          }

          if (writes.length) await upsertMany(pool, writes);
          if (deletions.length) await deleteMany(pool, deletions);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.warn(`⚠️ Failed to persist auth keys to Neon: ${message}`);
        }
      },
    } as any,
  };

  return {
    state,
    saveCreds: async () => {
      try {
        await upsertMany(pool, [{ id: credsKey, value: state.creds }]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`⚠️ Failed to persist auth creds to Neon: ${message}`);
      }
    },
    close: async () => {
      await pool.end();
    },
  };
}