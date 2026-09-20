import http from "http";
import crypto from "crypto";
import QRCode from "qrcode";
import { getBotStatus, isHealthy } from "./botStatus";
import { renderAdminPage } from "./adminPage";
import { handlePublicApi } from "../api/publicApi";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKeyRole,
} from "../../storage/core/apiKeyRepository";

let isHealthServerStarted = false;

/**
 * Admin auth: single shared token from ADMIN_TOKEN, sent as
 * `Authorization: Bearer <token>`. Constant-time compare, and a small
 * in-memory failure counter per IP so the token can't be brute-forced
 * through Render's public URL.
 */
const failedAttempts = new Map<string, { count: number; blockedUntil: number }>();
const MAX_FAILS = 10;
const BLOCK_MS = 15 * 60 * 1000;

function clientIp(req: http.IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(",")[0];
  return (first || req.socket.remoteAddress || "unknown").trim();
}

function isAuthorized(req: http.IncomingMessage): boolean {
  const expected = process.env.ADMIN_TOKEN || "";
  if (!expected) return false;
  const ip = clientIp(req);
  const rec = failedAttempts.get(ip);
  if (rec && rec.blockedUntil > Date.now()) return false;

  const header = req.headers.authorization || "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (ok) {
    failedAttempts.delete(ip);
    return true;
  }
  const next = { count: (rec?.count || 0) + 1, blockedUntil: 0 };
  if (next.count >= MAX_FAILS) next.blockedUntil = Date.now() + BLOCK_MS;
  failedAttempts.set(ip, next);
  return false;
}

function readJsonBody(req: http.IncomingMessage, limit = 16 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Hooks the dashboard can trigger; wired up by bot.ts so this file stays Baileys-free. */
export interface AdminActions {
  relink: () => Promise<void>;
  restart: () => void;
}

let adminActions: AdminActions | null = null;
export function registerAdminActions(actions: AdminActions): void {
  adminActions = actions;
}

async function handleAdminApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  route: string,
): Promise<void> {
  if (!isAuthorized(req)) {
    json(res, 401, { error: "unauthorized" });
    return;
  }

  const s = getBotStatus();

  if (route === "status" && req.method === "GET") {
    const now = Date.now();
    json(res, 200, {
      state: s.state,
      healthy: isHealthy(),
      selfJid: s.selfJid,
      uptimeSec: Math.round((now - s.startedAt) / 1000),
      lastOpenAt: s.lastOpenAt,
      lastCloseAt: s.lastCloseAt,
      lastCloseCode: s.lastCloseCode,
      lastInboundAt: s.lastInboundAt,
      lastOutboundAt: s.lastOutboundAt,
      reconnectAttempts: s.reconnectAttempts,
      qrAvailable: !!s.qr,
      qrAgeSec: s.qrAt ? Math.round((now - s.qrAt) / 1000) : null,
      version: process.env.RENDER_GIT_COMMIT?.slice(0, 7) || null,
    });
    return;
  }

  if (route === "qr.svg" && req.method === "GET") {
    if (!s.qr) {
      json(res, 404, { error: "no_qr", state: s.state });
      return;
    }
    const svg = await QRCode.toString(s.qr, { type: "svg", margin: 1, width: 280 });
    res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" });
    res.end(svg);
    return;
  }

  if (route === "relink" && req.method === "POST") {
    if (!adminActions) {
      json(res, 503, { error: "actions_not_ready" });
      return;
    }
    json(res, 202, { ok: true, message: "Wiping session and restarting. Reload in ~30s for a fresh QR." });
    // Respond first, then tear down — the process is about to exit.
    setTimeout(() => {
      adminActions!.relink().catch((err) => console.error("[admin] relink failed:", err));
    }, 100);
    return;
  }

  if (route === "restart" && req.method === "POST") {
    if (!adminActions) {
      json(res, 503, { error: "actions_not_ready" });
      return;
    }
    json(res, 202, { ok: true, message: "Restarting." });
    setTimeout(() => adminActions!.restart(), 100);
    return;
  }

  // ── API key management ──────────────────────────────────────────────
  if (route === "keys" && req.method === "GET") {
    json(res, 200, { keys: await listApiKeys() });
    return;
  }

  if (route === "keys" && req.method === "POST") {
    let body: any;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      json(res, 400, { error: (err as Error).message });
      return;
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const role: ApiKeyRole = body.role === "viewer" ? "viewer" : "operator";
    const botRaw = body.botNumber;
    const botNumber =
      botRaw === null || botRaw === undefined || botRaw === "" ? null : Number(botRaw);
    if (!name) {
      json(res, 400, { error: "bad_request", detail: "`name` is required" });
      return;
    }
    if (botNumber !== null && (!Number.isInteger(botNumber) || botNumber < 0)) {
      json(res, 400, { error: "bad_request", detail: "`botNumber` must be a non-negative integer or null" });
      return;
    }
    const { record, key } = await createApiKey(name, role, botNumber);
    // The raw key is shown exactly once; only its hash is persisted.
    json(res, 201, { key, record });
    return;
  }

  const revokeMatch = route.match(/^keys\/(\d+)$/);
  if (revokeMatch && req.method === "DELETE") {
    const ok = await revokeApiKey(Number(revokeMatch[1]));
    json(res, ok ? 200 : 404, ok ? { revoked: true } : { error: "not_found_or_already_revoked" });
    return;
  }

  json(res, 404, { error: "not_found" });
}

export function startHealthServer(): void {
  if (isHealthServerStarted) {
    return;
  }

  isHealthServerStarted = true;
  const port = Number(process.env.PORT || 3000);
  const adminEnabled = !!process.env.ADMIN_TOKEN;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const path = url.pathname;

    if (path === "/health") {
      // 503 when the socket isn't open so Render's health check (and any
      // uptime monitor) sees "down" instead of a green process with a dead WA link.
      const s = getBotStatus();
      const healthy = isHealthy();
      json(res, healthy ? 200 : 503, {
        status: healthy ? "ok" : "degraded",
        service: "mahoraga",
        state: s.state,
        lastOpenAt: s.lastOpenAt,
      });
      return;
    }

    if (path.startsWith("/api/v1/")) {
      const route = path.slice("/api/v1/".length);
      handlePublicApi(req, res, route).catch((err) => {
        console.error("[api] handler error:", err);
        if (!res.headersSent) json(res, 500, { error: "internal" });
      });
      return;
    }

    if (adminEnabled && path === "/admin") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(renderAdminPage());
      return;
    }

    if (adminEnabled && path.startsWith("/admin/api/")) {
      const route = path.slice("/admin/api/".length);
      handleAdminApi(req, res, route).catch((err) => {
        console.error("[admin] handler error:", err);
        if (!res.headersSent) json(res, 500, { error: "internal" });
      });
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("MAHORAGA is running");
  });

  server.listen(port, () => {
    console.log(`Health server listening on port ${port}${adminEnabled ? " (admin dashboard at /admin)" : ""}`);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err && err.code === "EADDRINUSE") {
      console.warn(
        `Health server port ${port} already in use. Continuing without health endpoint.`,
      );
      return;
    }
    console.error("Health server error:", err);
    throw err;
  });
}
