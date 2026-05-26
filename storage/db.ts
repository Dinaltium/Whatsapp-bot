import { Pool } from "pg";
import { getDatabaseUrl } from "./neonAuthStateStore";

// Global DB pool holder
let dbPool: Pool | null = null;

export function setPool(pool: Pool): void {
  dbPool = pool;
}

export async function closePool(): Promise<void> {
  if (dbPool) {
    try {
      await dbPool.end();
      console.log("Database connection pool closed.");
    } catch (e) {
      console.error("Error closing database pool:", e);
    }
    dbPool = null;
  }
}

export function getPool(): Pool | null {
  if (dbPool) return dbPool;

  const dbUrl = getDatabaseUrl();
  if (!dbUrl) {
    console.warn(
      "⚠️ DATABASE_URL is not set. Running in static fallback mode.",
    );
    return null;
  }

  try {
    dbPool = new Pool({
      connectionString: dbUrl,
      // Neon free tier allows ~5 concurrent connections; keep pool small to
      // avoid exhaustion when auth store + app pool both connect on cold start.
      max: Number(process.env.DB_POOL_MAX || 3),
      // 30 s gives Neon time to wake from cold start before giving up.
      connectionTimeoutMillis: Number(
        process.env.DB_CONNECT_TIMEOUT_MS || 30000,
      ),
      // 120 s keeps connections alive through a QR scan (which can take 60s+).
      // Without this, pg drops idle connections after 30 s and Neon has to
      // cold-start again exactly when the handshake fires keys.set().
      idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 120000),
      // TCP keepalive: sends OS-level probe packets on idle connections so
      // Neon's serverless compute doesn't terminate them silently with a RST.
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000, // start probing after 10s idle
      ssl:
        process.env.DATABASE_SSL === "false"
          ? false
          : {
              rejectUnauthorized:
                process.env.NODE_ENV === "production"
                  ? true
                  : process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false",
            },
    });

    dbPool.on("error", (err) => {
      console.warn("⚠️ dbPool error:", err.message);
    });

    return dbPool;
  } catch (error) {
    console.error("⚠️ Failed to initialize dbPool:", error);
    return null;
  }
}

/**
 * Actively warm the pool by running a trivial query.
 * Call this before initialising the WhatsApp socket so Neon has a live
 * connection ready when the first `keys.set()` fires during the handshake.
 */
export async function warmPool(retries = 5, delayMs = 3000): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pool.query("SELECT 1");
      console.log("Database pool warmed successfully.");
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`⚠️ DB warm attempt ${attempt}/${retries} failed: ${msg}`);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  // Non-fatal — bot can still try; the write-queue will retry on failure.
  console.warn("⚠️ Could not warm DB pool after all retries. Continuing anyway.");
}


// Bootstrap schema
export async function ensureSchema(): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  try {
    // Check if the old schema needs to be dropped (i.e. does not have the 'id' column)
    const tableCheck = await pool.query(`
      SELECT 1 
      FROM information_schema.tables 
      WHERE table_name = 'wa_allowed_groups'
      LIMIT 1;
    `);

    const columnCheck = await pool.query(`
      SELECT 1 
      FROM information_schema.columns 
      WHERE table_name = 'wa_allowed_groups' AND column_name = 'id'
      LIMIT 1;
    `);

    if (tableCheck.rows.length > 0 && columnCheck.rows.length === 0) {
      console.log("Upgrading allowed groups and allowed chats schemas to support sequential IDs...");
      await pool.query("DROP TABLE IF EXISTS wa_allowed_groups CASCADE;");
      await pool.query("DROP TABLE IF EXISTS wa_allowed_chats CASCADE;");
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS dk24_clubs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        college TEXT NOT NULL,
        description TEXT NOT NULL,
        website TEXT,
        logo TEXT,
        pocs JSONB NOT NULL DEFAULT '[]'::jsonb,
        representatives JSONB NOT NULL DEFAULT '[]'::jsonb,
        last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS dk24_events (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        host TEXT,
        date TEXT,
        location TEXT,
        description TEXT,
        registration_deadline TEXT,
        prize_pool TEXT,
        tracks TEXT[],
        registration_link TEXT,
        join_link TEXT,
        youtube_link TEXT,
        poster_url TEXT,
        tags TEXT[],
        stage TEXT,
        month_year TEXT NOT NULL,
        last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS dk24_cache_log (
        key TEXT PRIMARY KEY,
        last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS dk24_managed_roles (
        jid TEXT NOT NULL,
        role TEXT NOT NULL,
        assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (jid, role)
      );

      CREATE TABLE IF NOT EXISTS rbac_roles (
        name TEXT PRIMARY KEY,
        description TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS rbac_role_permissions (
        role_name TEXT NOT NULL REFERENCES rbac_roles(name) ON DELETE CASCADE,
        permission TEXT NOT NULL,
        granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (role_name, permission)
      );

      CREATE TABLE IF NOT EXISTS rbac_user_roles (
        jid TEXT NOT NULL,
        role_name TEXT NOT NULL REFERENCES rbac_roles(name) ON DELETE CASCADE,
        assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (jid, role_name)
      );

      CREATE TABLE IF NOT EXISTS dk24_mentors (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        expertise TEXT,
        linkedin TEXT,
        organization TEXT,
        description TEXT,
        instagram TEXT,
        github TEXT,
        email TEXT,
        phone TEXT,
        added_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE dk24_mentors ADD COLUMN IF NOT EXISTS description TEXT;
      ALTER TABLE dk24_mentors ADD COLUMN IF NOT EXISTS instagram TEXT;
      ALTER TABLE dk24_mentors ADD COLUMN IF NOT EXISTS github TEXT;
      ALTER TABLE dk24_mentors ADD COLUMN IF NOT EXISTS email TEXT;
      ALTER TABLE dk24_mentors ADD COLUMN IF NOT EXISTS phone TEXT;
      ALTER TABLE dk24_mentors ALTER COLUMN expertise DROP NOT NULL;

      CREATE TABLE IF NOT EXISTS wa_allowed_groups (
        id SERIAL PRIMARY KEY,
        jid TEXT UNIQUE NOT NULL,
        bot_number INTEGER NOT NULL DEFAULT 0,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS wa_allowed_chats (
        id SERIAL PRIMARY KEY,
        jid TEXT UNIQUE NOT NULL,
        bot_number INTEGER NOT NULL DEFAULT 0,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS wa_daily_user_usage (
        jid TEXT NOT NULL,
        usage_type TEXT NOT NULL,
        day DATE NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (jid, usage_type, day)
      );

      -- Maps WhatsApp LID identifiers to canonical phone JIDs.
      -- Populated when !manage assigns a role and the person's LID
      -- is found in group metadata. Used to resolve @lid senders
      -- to their @s.whatsapp.net JID for RBAC permission checks.
      CREATE TABLE IF NOT EXISTS wa_lid_phone_map (
        lid TEXT PRIMARY KEY,
        phone_jid TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS dk24_action_logs (
        id SERIAL PRIMARY KEY,
        actor_jid TEXT NOT NULL,
        action_type TEXT NOT NULL,
        target_id TEXT,
        target_name TEXT,
        details TEXT,
        logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      INSERT INTO rbac_roles (name, description)
      VALUES ('mentor', 'Can manage mentor intake and mentor directory records')
      ON CONFLICT (name) DO NOTHING;

      INSERT INTO rbac_role_permissions (role_name, permission)
      VALUES ('mentor', 'mentor.manage')
      ON CONFLICT (role_name, permission) DO NOTHING;

      INSERT INTO rbac_roles (name, description)
      SELECT DISTINCT LOWER(TRIM(role)), 'Migrated legacy managed role'
      FROM dk24_managed_roles
      WHERE TRIM(role) <> ''
      ON CONFLICT (name) DO NOTHING;

      INSERT INTO rbac_user_roles (jid, role_name, assigned_at)
      SELECT jid, LOWER(TRIM(role)), assigned_at
      FROM dk24_managed_roles
      WHERE TRIM(role) <> ''
      ON CONFLICT (jid, role_name) DO NOTHING;
    `);
    console.log("Database schema verified.");
  } catch (error) {
    console.error("Failed to bootstrap database schema:", error);
  }
}
