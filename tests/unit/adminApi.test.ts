import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import http from "http";
import { configureAdminApi, handleAdminApi, type AllowEntry } from "../../infrastructure/health/adminApi";
import { markOpen, markClosed } from "../../infrastructure/health/botStatus";

const PORT = 39323;

// In-memory stand-in for the allowlist singletons; mirrors their contract.
function fakeList(seed: AllowEntry[]) {
  let rows = seed.map((r) => ({ ...r }));
  let nextId = Math.max(0, ...seed.map((r) => r.id)) + 1;
  return {
    list: () => rows,
    add: async (jid: string, botNumber: number) => {
      rows.push({ id: nextId++, jid, botNumber, enabled: true });
      return true;
    },
    remove: async (id: number) => {
      const before = rows.length;
      rows = rows.filter((r) => r.id !== id);
      return rows.length < before;
    },
    setBot: async (id: number, botNumber: number) => {
      const r = rows.find((x) => x.id === id);
      if (!r) return false;
      r.botNumber = botNumber;
      return true;
    },
    setEnabled: async (id: number, enabled: boolean) => {
      const r = rows.find((x) => x.id === id);
      if (!r) return false;
      r.enabled = enabled;
      return true;
    },
    reset: () => {
      rows = seed.map((r) => ({ ...r }));
    },
  };
}

const groups = fakeList([
  { id: 1, jid: "111@g.us", botNumber: 2, enabled: true },
  { id: 2, jid: "222@g.us", botNumber: 1, enabled: false },
]);
const chats = fakeList([{ id: 10, jid: "919000000001@s.whatsapp.net", botNumber: 3, enabled: true }]);

function call(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const r = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path,
        method: opts.method || "GET",
        headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {},
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
  configureAdminApi({
    relink: async () => {},
    restart: () => {},
    groups,
    chats,
    discoverGroups: async () => [
      { jid: "111@g.us", subject: "DKB Mentors", size: 40 },
      { jid: "999@g.us", subject: "Random Chatter", size: 12 },
    ],
    botLabels: () => ({ 0: "Generic", 1: "ECB", 2: "DKB", 3: "PARAG" }),
    normalizeJid: (j) => (/^\d+$/.test(j) ? `${j}@s.whatsapp.net` : j),
  });
  const server = http.createServer((req, res) => {
    const path = new URL(req.url || "/", "http://x").pathname;
    handleAdminApi(req, res, path.replace(/^\/admin\/api\//, "")).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(PORT, r));
  server.unref();
});

beforeEach(() => {
  groups.reset();
  chats.reset();
  markOpen("919999999999@s.whatsapp.net");
});

describe("allowlist CRUD", () => {
  it("lists groups and chats", async () => {
    expect((await call("/admin/api/groups")).json.groups).toHaveLength(2);
    expect((await call("/admin/api/chats")).json.chats).toHaveLength(1);
  });

  it("adds a group with a bot number", async () => {
    const r = await call("/admin/api/groups", { method: "POST", body: { jid: "333@g.us", botNumber: 2 } });
    expect(r.status).toBe(201);
    expect(groups.list().map((g) => g.jid)).toContain("333@g.us");
  });

  it("rejects a chat JID posted to the groups list", async () => {
    const r = await call("/admin/api/groups", { method: "POST", body: { jid: "919000@s.whatsapp.net", botNumber: 2 } });
    expect(r.status).toBe(400);
  });

  it("normalizes a bare phone number into a chat JID", async () => {
    const r = await call("/admin/api/chats", { method: "POST", body: { jid: "919111111111", botNumber: 0 } });
    expect(r.status).toBe(201);
    expect(r.json.jid).toBe("919111111111@s.whatsapp.net");
  });

  it("409s on duplicates", async () => {
    const r = await call("/admin/api/groups", { method: "POST", body: { jid: "111@g.us", botNumber: 2 } });
    expect(r.status).toBe(409);
  });

  it("patches bot number and enabled independently, reporting what changed", async () => {
    const r1 = await call("/admin/api/groups/1", { method: "PATCH", body: { botNumber: 3 } });
    expect(r1.status).toBe(200);
    expect(r1.json.updated).toEqual(["botNumber"]);
    expect(r1.json.entry.botNumber).toBe(3);

    const r2 = await call("/admin/api/groups/2", { method: "PATCH", body: { enabled: true } });
    expect(r2.json.updated).toEqual(["enabled"]);
    expect(groups.list().find((g) => g.id === 2)!.enabled).toBe(true);

    const r3 = await call("/admin/api/groups/1", { method: "PATCH", body: { botNumber: 3 } });
    expect(r3.json.updated).toEqual([]); // no-op is fine, not an error
  });

  it("404s on unknown ids and validates bot numbers", async () => {
    expect((await call("/admin/api/groups/77", { method: "PATCH", body: { enabled: false } })).status).toBe(404);
    expect((await call("/admin/api/groups/1", { method: "PATCH", body: { botNumber: -1 } })).status).toBe(400);
  });

  it("removes an entry", async () => {
    const r = await call("/admin/api/chats/10", { method: "DELETE" });
    expect(r.status).toBe(200);
    expect(chats.list()).toHaveLength(0);
  });
});

describe("group discovery", () => {
  it("marks which live groups are already allowlisted, unlisted first", async () => {
    const r = await call("/admin/api/discover/groups");
    expect(r.status).toBe(200);
    expect(r.json.groups.map((g: any) => [g.jid, g.allowlisted])).toEqual([
      ["999@g.us", false],
      ["111@g.us", true],
    ]);
  });

  it("503s when the socket is down", async () => {
    markClosed(428, false);
    expect((await call("/admin/api/discover/groups")).status).toBe(503);
  });
});

describe("status", () => {
  it("includes bot labels so the UI can render names, not numbers", async () => {
    const r = await call("/admin/api/status");
    expect(r.json.bots).toMatchObject({ 2: "DKB" });
  });
});
