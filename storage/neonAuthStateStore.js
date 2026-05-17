const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const {
  initAuthCreds,
  BufferJSON
} = require("@whiskeysockets/baileys");

const AUTH_TABLE = "wa_auth_state";
const DEFAULT_NAMESPACE = "parag";

function getDatabaseUrl() {
  return process.env.DATABASE_URL || process.env.NEON_DATABASE_URL || null;
}

function getJwtSecret() {
  return process.env.AUTH_STATE_JWT_SECRET || null;
}

function serializeStateValue(value) {
  const json = JSON.stringify(value, BufferJSON.replacer);
  const secret = getJwtSecret();

  if (!secret) {
    return `json:${json}`;
  }

  const token = jwt.sign(
    {
      data: json
    },
    secret,
    {
      algorithm: "HS256"
    }
  );

  return `jwt:${token}`;
}

function deserializeStateValue(raw) {
  if (!raw) return null;

  if (raw.startsWith("jwt:")) {
    const token = raw.slice(4);
    const secret = getJwtSecret();

    if (!secret) {
      throw new Error("AUTH_STATE_JWT_SECRET is required to read JWT-wrapped auth state.");
    }

    const decoded = jwt.verify(token, secret, {
      algorithms: ["HS256"]
    });

    return JSON.parse(decoded.data, BufferJSON.reviver);
  }

  const payload = raw.startsWith("json:") ? raw.slice(5) : raw;
  return JSON.parse(payload, BufferJSON.reviver);
}

function buildStorageKey(namespace, kind, type, id) {
  if (kind === "creds") {
    return `${namespace}:creds`;
  }

  return `${namespace}:key:${type}:${id}`;
}

async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${AUTH_TABLE} (
      id TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function readOne(pool, id) {
  const result = await pool.query(
    `SELECT value FROM ${AUTH_TABLE} WHERE id = $1 LIMIT 1`,
    [id]
  );

  if (!result.rows.length) {
    return null;
  }

  return deserializeStateValue(result.rows[0].value);
}

async function upsertOne(pool, id, value) {
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
    [id, encoded]
  );
}

async function deleteMany(pool, ids) {
  if (!ids.length) return;

  await pool.query(
    `DELETE FROM ${AUTH_TABLE} WHERE id = ANY($1::text[])`,
    [ids]
  );
}

async function readMany(pool, ids) {
  if (!ids.length) return new Map();

  const result = await pool.query(
    `SELECT id, value FROM ${AUTH_TABLE} WHERE id = ANY($1::text[])`,
    [ids]
  );

  const mapped = new Map();
  for (const row of result.rows) {
    mapped.set(row.id, deserializeStateValue(row.value));
  }

  return mapped;
}

async function useNeonAuthState(namespace = DEFAULT_NAMESPACE) {
  const databaseUrl = getDatabaseUrl();

  if (!databaseUrl) {
    throw new Error("DATABASE_URL (or NEON_DATABASE_URL) is required for Neon auth storage.");
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.DATABASE_SSL === "false"
      ? false
      : {
        rejectUnauthorized: false
      }
  });

  await ensureSchema(pool);

  const credsKey = buildStorageKey(namespace, "creds");
  const creds = (await readOne(pool, credsKey)) || initAuthCreds();

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const keyIds = ids.map((id) => buildStorageKey(namespace, "key", type, id));
        const rows = await readMany(pool, keyIds);
        const data = {};

        ids.forEach((id) => {
          const dbKey = buildStorageKey(namespace, "key", type, id);
          const value = rows.get(dbKey);
          if (value) {
            data[id] = value;
          }
        });

        return data;
      },

      set: async (data) => {
        const writes = [];
        const deletions = [];

        for (const [type, typeData] of Object.entries(data)) {
          for (const [id, value] of Object.entries(typeData)) {
            const dbKey = buildStorageKey(namespace, "key", type, id);

            if (value) {
              writes.push(upsertOne(pool, dbKey, value));
            } else {
              deletions.push(dbKey);
            }
          }
        }

        if (writes.length) {
          await Promise.all(writes);
        }

        if (deletions.length) {
          await deleteMany(pool, deletions);
        }
      }
    }
  };

  const saveCreds = async () => {
    await upsertOne(pool, credsKey, state.creds);
  };

  return {
    state,
    saveCreds,
    close: async () => {
      await pool.end();
    }
  };
}

module.exports = {
  useNeonAuthState,
  getDatabaseUrl
};
