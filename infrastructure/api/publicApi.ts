/**
 * Public REST API — /api/v1/*
 *
 * Lets scripts, n8n, cron jobs, etc. send through MAHORAGA without touching
 * WhatsApp directly. Every send goes through the same `sendBotReply` path as
 * a chat command, so the per-recipient cap, global account cap, typing delay
 * and secret scrubber all still apply. There is deliberately no bypass.
 *
 * Auth: `Authorization: Bearer <key>` where <key> is either an api_keys row
 * (mhk_…) or the ADMIN_TOKEN (treated as an unscoped operator).
 *
 * Recipient policy: the target must be an allowlisted group/chat (or an admin
 * JID). A key scoped to a bot number may only send into chats assigned to that
 * bot. This keeps the API from becoming a generic spam cannon on your number.
 *
 * All collaborators are injected via `deps` so the routing/policy logic is
 * unit-testable without Baileys, Postgres or the allowlist singletons.
 */
import http from "http";
import crypto from "crypto";
import type { ApiKeyRecord, ApiKeyRole } from "../../storage/core/apiKeyRepository";

export interface Principal {
  kind: "admin" | "key";
  role: ApiKeyRole;
  botNumber: number | null;
  keyId: number | null;
  label: string;
}

export interface AllowlistEntry {
  id: number;
  jid: string;
  botNumber: number;
  enabled: boolean;
}

export interface PublicApiDeps {
  adminToken: () => string;
  verifyApiKey: (raw: string) => Promise<ApiKeyRecord | null>;
  send: (to: string, text: string) => Promise<void>;
  isSocketOpen: () => boolean;
  normalizeJid: (jid: string) => string | null | undefined;
  listGroups: () => AllowlistEntry[];
  listChats: () => AllowlistEntry[];
  adminJids: () => string[];
  statusSnapshot: () => Record<string, unknown>;
  now?: () => number;
}

let deps: PublicApiDeps | null = null;

export function configurePublicApi(d: PublicApiDeps): void {
  deps = d;
}

export function isPublicApiConfigured(): boolean {
  return deps !== null;
}

// ── helpers ───────────────────────────────────────────────────────────────

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

const MAX_BODY = 64 * 1024;

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Per-principal request throttle (in-memory, resets on restart). The real
// account-level guard is inside sendBotReply; this just stops one misbehaving
// script from hammering the endpoint.
const API_PER_MIN = Number(process.env.API_REQUESTS_PER_MIN || 30);
const buckets = new Map<string, { minute: number; count: number }>();

function throttled(principalKey: string, now: number): boolean {
  const minute = Math.floor(now / 60_000);
  const b = buckets.get(principalKey);
  if (!b || b.minute !== minute) {
    buckets.set(principalKey, { minute, count: 1 });
    return false;
  }
  b.count += 1;
  return b.count > API_PER_MIN;
}

export async function authenticate(req: http.IncomingMessage): Promise<Principal | null> {
  if (!deps) return null;
  const header = req.headers.authorization || "";
  const raw = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!raw) return null;

  const admin = deps.adminToken();
  if (admin && timingSafeEqualStr(raw, admin)) {
    return { kind: "admin", role: "operator", botNumber: null, keyId: null, label: "admin-token" };
  }

  const rec = await deps.verifyApiKey(raw);
  if (!rec) return null;
  return { kind: "key", role: rec.role, botNumber: rec.botNumber, keyId: rec.id, label: rec.name };
}

/**
 * Pure recipient policy. Exported for tests.
 * Returns an error code or null when the send is permitted.
 */
export function checkRecipient(
  principal: Principal,
  jid: string,
  groups: AllowlistEntry[],
  chats: AllowlistEntry[],
  adminJids: string[],
): string | null {
  const isGroup = jid.endsWith("@g.us");
  const entry = (isGroup ? groups : chats).find((e) => e.jid === jid);

  if (!entry) {
    // Admins may always be messaged (boot notices, alerts) even if not allowlisted.
    if (!isGroup && adminJids.includes(jid)) return null;
    return "recipient_not_allowlisted";
  }
  if (!entry.enabled) return "recipient_disabled";
  if (principal.botNumber !== null && entry.botNumber !== principal.botNumber) {
    return "bot_scope_mismatch";
  }
  return null;
}

function scoped<T extends AllowlistEntry>(principal: Principal, rows: T[]): T[] {
  return principal.botNumber === null ? rows : rows.filter((r) => r.botNumber === principal.botNumber);
}

// ── router ────────────────────────────────────────────────────────────────

export async function handlePublicApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  route: string,
): Promise<void> {
  if (!deps) {
    json(res, 503, { error: "api_not_ready" });
    return;
  }
  const now = (deps.now || Date.now)();

  const principal = await authenticate(req);
  if (!principal) {
    json(res, 401, { error: "unauthorized" });
    return;
  }
  if (throttled(principal.kind === "admin" ? "admin" : `key:${principal.keyId}`, now)) {
    json(res, 429, { error: "rate_limited", limitPerMin: API_PER_MIN });
    return;
  }

  // GET /api/v1/status
  if (route === "status" && req.method === "GET") {
    json(res, 200, { ...deps.statusSnapshot(), principal: { role: principal.role, botNumber: principal.botNumber } });
    return;
  }

  // GET /api/v1/groups | /api/v1/chats
  if ((route === "groups" || route === "chats") && req.method === "GET") {
    const rows = scoped(principal, route === "groups" ? deps.listGroups() : deps.listChats());
    json(res, 200, { [route]: rows });
    return;
  }

  // POST /api/v1/messages  { to, text }
  if (route === "messages" && req.method === "POST") {
    if (principal.role !== "operator") {
      json(res, 403, { error: "forbidden", detail: "viewer keys cannot send" });
      return;
    }
    let body: any;
    try {
      body = await readJson(req);
    } catch (err) {
      json(res, 400, { error: (err as Error).message });
      return;
    }
    const to = typeof body.to === "string" ? body.to.trim() : "";
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!to || !text) {
      json(res, 400, { error: "bad_request", detail: "`to` and `text` are required" });
      return;
    }
    if (text.length > 4000) {
      json(res, 400, { error: "bad_request", detail: "`text` exceeds 4000 chars" });
      return;
    }
    const jid = deps.normalizeJid(to);
    if (!jid || !/@(s\.whatsapp\.net|g\.us|lid)$/.test(jid)) {
      json(res, 400, { error: "bad_request", detail: "`to` is not a valid JID or phone number" });
      return;
    }
    const denied = checkRecipient(principal, jid, deps.listGroups(), deps.listChats(), deps.adminJids());
    if (denied) {
      json(res, 403, { error: denied, to: jid });
      return;
    }
    if (!deps.isSocketOpen()) {
      json(res, 503, { error: "socket_not_open" });
      return;
    }
    try {
      await deps.send(jid, text);
      // 202 not 200: sendBotReply silently drops a message that trips the
      // per-recipient or global outbound cap, so "accepted" is the honest word.
      json(res, 202, { accepted: true, to: jid, sentBy: principal.label });
    } catch (err) {
      json(res, 502, { error: "send_failed", detail: (err as Error).message });
    }
    return;
  }

  json(res, 404, { error: "not_found" });
}
