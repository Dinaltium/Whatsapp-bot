import http from "http";
import crypto from "crypto";
import { getBotStatus, isHealthy } from "./botStatus";
import { renderAdminPage } from "./adminPage";
import { handleAdminApi } from "./adminApi";
import { handlePublicApi } from "../api/publicApi";

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

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
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
      if (!isAuthorized(req)) {
        json(res, 401, { error: "unauthorized" });
        return;
      }
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
