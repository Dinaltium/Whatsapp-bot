/**
 * API keys for the public REST API (/api/v1/*).
 *
 * Only a SHA-256 hash of the key is stored; the raw key is returned exactly
 * once at creation. Keys carry a role and an optional bot-number scope:
 *   operator — may send messages (as that bot, into that bot's allowlisted chats)
 *   viewer   — read-only (status, group/chat listings)
 *   botNumber null = any bot.
 */
import crypto from "crypto";
import { getPool } from "../db";

export type ApiKeyRole = "operator" | "viewer";

export interface ApiKeyRecord {
  id: number;
  name: string;
  prefix: string;
  role: ApiKeyRole;
  botNumber: number | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

const KEY_PREFIX = "mhk_";

export function hashApiKey(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export function generateApiKey(): string {
  return KEY_PREFIX + crypto.randomBytes(24).toString("hex");
}

export function looksLikeApiKey(raw: string): boolean {
  return raw.startsWith(KEY_PREFIX) && raw.length === KEY_PREFIX.length + 48;
}

function rowToRecord(r: any): ApiKeyRecord {
  return {
    id: Number(r.id),
    name: r.name,
    prefix: r.prefix,
    role: r.role,
    botNumber: r.bot_number === null ? null : Number(r.bot_number),
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
  };
}

export async function createApiKey(
  name: string,
  role: ApiKeyRole,
  botNumber: number | null,
): Promise<{ record: ApiKeyRecord; key: string }> {
  const pool = getPool();
  if (!pool) throw new Error("Database pool unavailable");
  const key = generateApiKey();
  const prefix = key.slice(0, KEY_PREFIX.length + 6);
  const res = await pool.query(
    `INSERT INTO api_keys (name, key_hash, prefix, role, bot_number)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, prefix, role, bot_number, created_at, last_used_at, revoked_at`,
    [name.trim().slice(0, 64), hashApiKey(key), prefix, role, botNumber],
  );
  return { record: rowToRecord(res.rows[0]), key };
}

export async function listApiKeys(): Promise<ApiKeyRecord[]> {
  const pool = getPool();
  if (!pool) return [];
  const res = await pool.query(
    `SELECT id, name, prefix, role, bot_number, created_at, last_used_at, revoked_at
     FROM api_keys ORDER BY id`,
  );
  return res.rows.map(rowToRecord);
}

export async function revokeApiKey(id: number): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const res = await pool.query(
    `UPDATE api_keys SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL`,
    [id],
  );
  return (res.rowCount ?? 0) > 0;
}

// last_used_at is written at most once a minute per key to keep the hot
// path from turning every API call into a DB write.
const lastTouch = new Map<number, number>();

export async function verifyApiKey(raw: string): Promise<ApiKeyRecord | null> {
  if (!looksLikeApiKey(raw)) return null;
  const pool = getPool();
  if (!pool) return null;
  const res = await pool.query(
    `SELECT id, name, prefix, role, bot_number, created_at, last_used_at, revoked_at
     FROM api_keys WHERE key_hash = $1 LIMIT 1`,
    [hashApiKey(raw)],
  );
  if (res.rows.length === 0) return null;
  const rec = rowToRecord(res.rows[0]);
  if (rec.revokedAt) return null;

  const now = Date.now();
  if ((lastTouch.get(rec.id) || 0) + 60_000 < now) {
    lastTouch.set(rec.id, now);
    pool
      .query(`UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`, [rec.id])
      .catch(() => {});
  }
  return rec;
}
