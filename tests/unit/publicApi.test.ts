import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import http from "http";
import {
  configurePublicApi,
  handlePublicApi,
  checkRecipient,
  type Principal,
  type AllowlistEntry,
} from "../../infrastructure/api/publicApi";
import type { ApiKeyRecord } from "../../storage/core/apiKeyRepository";

const PORT = 39322;
const ADMIN = "admin-secret";
const OP_KEY = "mhk_" + "a".repeat(48);
const VIEW_KEY = "mhk_" + "b".repeat(48);
const DKB_KEY = "mhk_" + "c".repeat(48);

const groups: AllowlistEntry[] = [
  { id: 1, jid: "111@g.us", botNumber: 2, enabled: true },
  { id: 2, jid: "222@g.us", botNumber: 1, enabled: true },
  { id: 3, jid: "333@g.us", botNumber: 2, enabled: false },
];
const chats: AllowlistEntry[] = [{ id: 10, jid: "919000000001@s.whatsapp.net", botNumber: 3, enabled: true }];
const admins = ["919902849280@s.whatsapp.net"];

const sent: { to: string; text: string }[] = [];
let socketOpen = true;

function rec(id: number, name: string, role: "operator" | "viewer", botNumber: number | null): ApiKeyRecord {
  return { id, name, prefix: "mhk_xxxxxx", role, botNumber, createdAt: new Date(), lastUsedAt: null, revokedAt: null };
}

function call(
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const r = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path,
        method: opts.method || "GET",
        headers: {
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode || 0, json: body ? JSON.parse(body) : null }));
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

beforeAll(async () => {
  configurePublicApi({
    adminToken: () => ADMIN,
    verifyApiKey: async (raw) => {
      if (raw === OP_KEY) return rec(1, "op-any", "operator", null);
      if (raw === VIEW_KEY) return rec(2, "viewer", "viewer", null);
      if (raw === DKB_KEY) return rec(3, "dkb-only", "operator", 2);
      return null;
    },
    send: async (to, text) => {
      sent.push({ to, text });
    },
    isSocketOpen: () => socketOpen,
    normalizeJid: (j) => (/^\d+$/.test(j) ? `${j}@s.whatsapp.net` : j),
    listGroups: () => groups,
    listChats: () => chats,
    adminJids: () => admins,
    statusSnapshot: () => ({ state: "open" }),
  });
  const server = http.createServer((req, res) => {
    const path = new URL(req.url || "/", "http://x").pathname;
    handlePublicApi(req, res, path.replace(/^\/api\/v1\//, "")).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(PORT, r));
  server.unref();
});

beforeEach(() => {
  sent.length = 0;
  socketOpen = true;
});

describe("checkRecipient (pure policy)", () => {
  const anyOp: Principal = { kind: "key", role: "operator", botNumber: null, keyId: 1, label: "x" };
  const dkbOp: Principal = { kind: "key", role: "operator", botNumber: 2, keyId: 3, label: "y" };

  it("allows allowlisted enabled targets", () => {
    expect(checkRecipient(anyOp, "111@g.us", groups, chats, admins)).toBeNull();
    expect(checkRecipient(anyOp, "919000000001@s.whatsapp.net", groups, chats, admins)).toBeNull();
  });
  it("rejects unknown targets but lets admins through", () => {
    expect(checkRecipient(anyOp, "999@g.us", groups, chats, admins)).toBe("recipient_not_allowlisted");
    expect(checkRecipient(anyOp, "919111111111@s.whatsapp.net", groups, chats, admins)).toBe("recipient_not_allowlisted");
    expect(checkRecipient(anyOp, admins[0], groups, chats, admins)).toBeNull();
  });
  it("rejects disabled targets", () => {
    expect(checkRecipient(anyOp, "333@g.us", groups, chats, admins)).toBe("recipient_disabled");
  });
  it("enforces bot scope on scoped keys", () => {
    expect(checkRecipient(dkbOp, "111@g.us", groups, chats, admins)).toBeNull();
    expect(checkRecipient(dkbOp, "222@g.us", groups, chats, admins)).toBe("bot_scope_mismatch");
  });
});

describe("POST /api/v1/messages", () => {
  it("401 without a token", async () => {
    expect((await call("/api/v1/messages", { method: "POST", body: { to: "111@g.us", text: "x" } })).status).toBe(401);
  });
  it("401 with an unknown key", async () => {
    expect((await call("/api/v1/messages", { method: "POST", token: "mhk_" + "z".repeat(48), body: { to: "111@g.us", text: "x" } })).status).toBe(401);
  });
  it("403 for viewer keys", async () => {
    const r = await call("/api/v1/messages", { method: "POST", token: VIEW_KEY, body: { to: "111@g.us", text: "x" } });
    expect(r.status).toBe(403);
    expect(sent).toHaveLength(0);
  });
  it("400 when fields are missing", async () => {
    expect((await call("/api/v1/messages", { method: "POST", token: OP_KEY, body: { to: "111@g.us" } })).status).toBe(400);
    expect((await call("/api/v1/messages", { method: "POST", token: OP_KEY, body: { text: "hi" } })).status).toBe(400);
  });
  it("403 for a non-allowlisted recipient", async () => {
    const r = await call("/api/v1/messages", { method: "POST", token: OP_KEY, body: { to: "999@g.us", text: "x" } });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("recipient_not_allowlisted");
    expect(sent).toHaveLength(0);
  });
  it("403 when a scoped key targets another bot's chat", async () => {
    const r = await call("/api/v1/messages", { method: "POST", token: DKB_KEY, body: { to: "222@g.us", text: "x" } });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("bot_scope_mismatch");
  });
  it("202 and sends through the injected sender", async () => {
    const r = await call("/api/v1/messages", { method: "POST", token: OP_KEY, body: { to: "111@g.us", text: "hello" } });
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ accepted: true, to: "111@g.us", sentBy: "op-any" });
    expect(sent).toEqual([{ to: "111@g.us", text: "hello" }]);
  });
  it("normalizes a bare phone number and allows admins", async () => {
    const r = await call("/api/v1/messages", { method: "POST", token: ADMIN, body: { to: "919902849280", text: "ping" } });
    expect(r.status).toBe(202);
    expect(sent[0].to).toBe("919902849280@s.whatsapp.net");
  });
  it("503 when the socket is not open", async () => {
    socketOpen = false;
    const r = await call("/api/v1/messages", { method: "POST", token: OP_KEY, body: { to: "111@g.us", text: "x" } });
    expect(r.status).toBe(503);
    expect(sent).toHaveLength(0);
  });
});

describe("read endpoints", () => {
  it("viewer can read status", async () => {
    const r = await call("/api/v1/status", { token: VIEW_KEY });
    expect(r.status).toBe(200);
    expect(r.json.state).toBe("open");
    expect(r.json.principal.role).toBe("viewer");
  });
  it("scoped key only sees its own bot's groups", async () => {
    const r = await call("/api/v1/groups", { token: DKB_KEY });
    expect(r.status).toBe(200);
    expect(r.json.groups.map((g: AllowlistEntry) => g.jid)).toEqual(["111@g.us", "333@g.us"]);
  });
  it("unscoped key sees everything", async () => {
    const r = await call("/api/v1/chats", { token: OP_KEY });
    expect(r.json.chats).toHaveLength(1);
  });
  it("404 on unknown routes", async () => {
    expect((await call("/api/v1/nope", { token: OP_KEY })).status).toBe(404);
  });
});
