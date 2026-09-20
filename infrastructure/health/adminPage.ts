/**
 * Single-file admin dashboard. Plain HTML + vanilla JS, served by the health
 * server — no framework, no build step, nothing extra in the container.
 *
 * Auth: the page asks for ADMIN_TOKEN once, keeps it in sessionStorage, and
 * sends it as a Bearer header on every /admin/api call. The HTML itself is
 * public but contains nothing sensitive; every data call is gated server-side.
 */
export function renderAdminPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MAHORAGA</title>
<style>
  :root { --bg:#0b0e11; --card:#141920; --line:#232b35; --fg:#e6edf3; --muted:#8b98a5; --ok:#3fb950; --warn:#d29922; --bad:#f85149; --accent:#58a6ff; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  header { padding:16px 20px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:12px; }
  header h1 { margin:0; font-size:16px; letter-spacing:.08em; }
  header small { color:var(--muted); }
  main { max-width:960px; margin:0 auto; padding:20px; display:grid; gap:16px; grid-template-columns:1fr; }
  @media (min-width:760px) { main { grid-template-columns:1fr 1fr; } }
  .card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:16px; }
  .card h2 { margin:0 0 12px; font-size:12px; text-transform:uppercase; letter-spacing:.1em; color:var(--muted); }
  .kv { display:grid; grid-template-columns:auto 1fr; gap:4px 16px; }
  .kv dt { color:var(--muted); }
  .kv dd { margin:0; word-break:break-all; }
  .pill { display:inline-block; padding:2px 10px; border-radius:999px; font-weight:600; font-size:12px; }
  .pill.open { background:rgba(63,185,80,.15); color:var(--ok); }
  .pill.connecting, .pill.starting { background:rgba(210,153,34,.15); color:var(--warn); }
  .pill.closed, .pill.logged_out { background:rgba(248,81,73,.15); color:var(--bad); }
  button { background:transparent; color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:8px 14px; cursor:pointer; font:inherit; }
  button:hover { border-color:var(--accent); }
  button.danger { border-color:rgba(248,81,73,.5); color:var(--bad); }
  button.danger:hover { background:rgba(248,81,73,.1); }
  .actions { display:flex; gap:8px; flex-wrap:wrap; }
  #qr { display:flex; align-items:center; justify-content:center; min-height:300px; background:#fff; border-radius:6px; }
  #qr img { width:280px; height:280px; image-rendering:pixelated; }
  #qr .none { color:#555; font-size:13px; }
  #login { max-width:420px; margin:80px auto; }
  input { width:100%; padding:10px; background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:6px; font:inherit; margin-bottom:10px; }
  .msg { color:var(--muted); font-size:12px; min-height:18px; margin-top:8px; }
  .hidden { display:none; }
  footer { text-align:center; color:var(--muted); font-size:11px; padding:20px; }
  .wide { grid-column:1 / -1; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:500; font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
  td.muted { color:var(--muted); }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .row input, .row select { width:auto; margin:0; flex:1 1 120px; }
  select { padding:10px; background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:6px; font:inherit; }
  code.key { display:block; padding:10px; background:var(--bg); border:1px dashed var(--accent); border-radius:6px; word-break:break-all; user-select:all; margin-top:8px; }
  button.small { padding:4px 10px; font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>MAHORAGA</h1>
  <small>Modular Autonomous Helper for Operations, Retrieval, Automation &amp; General Assistance</small>
</header>

<section id="login" class="card">
  <h2>Admin token</h2>
  <input id="tok" type="password" placeholder="ADMIN_TOKEN" autocomplete="current-password">
  <button id="loginBtn">Enter</button>
  <div class="msg" id="loginMsg"></div>
</section>

<main id="dash" class="hidden">
  <div class="card">
    <h2>Session</h2>
    <dl class="kv">
      <dt>State</dt><dd><span id="state" class="pill">…</span></dd>
      <dt>Number</dt><dd id="selfJid">—</dd>
      <dt>Uptime</dt><dd id="uptime">—</dd>
      <dt>Last open</dt><dd id="lastOpen">—</dd>
      <dt>Last close</dt><dd id="lastClose">—</dd>
      <dt>Last inbound</dt><dd id="lastIn">—</dd>
      <dt>Last outbound</dt><dd id="lastOut">—</dd>
      <dt>Reconnects</dt><dd id="reconnects">—</dd>
      <dt>Build</dt><dd id="version">—</dd>
    </dl>
    <div class="actions" style="margin-top:14px">
      <button id="refreshBtn">Refresh</button>
      <button id="restartBtn">Restart process</button>
      <button id="relinkBtn" class="danger">Wipe session &amp; relink</button>
      <button id="logoutBtn">Forget token</button>
    </div>
    <div class="msg" id="actionMsg"></div>
  </div>

  <div class="card">
    <h2>Pair device</h2>
    <div id="qr"><span class="none">No QR pending — session is linked.</span></div>
    <div class="msg" id="qrMsg">QR refreshes automatically. Scan from WhatsApp → Linked devices.</div>
  </div>
  <div class="card wide">
    <h2>API keys · <span style="text-transform:none;letter-spacing:0">POST /api/v1/messages · GET /api/v1/status · /groups · /chats</span></h2>
    <div class="row" style="margin-bottom:12px">
      <input id="kName" placeholder="name (e.g. n8n-dkb)">
      <select id="kRole"><option value="operator">operator (send)</option><option value="viewer">viewer (read)</option></select>
      <input id="kBot" placeholder="bot # (blank = any)" inputmode="numeric" style="flex:0 1 150px">
      <button id="kCreate">Create key</button>
    </div>
    <div id="kNew" class="hidden">
      <div class="msg">Copy now — shown once, only the hash is stored.</div>
      <code class="key" id="kNewVal"></code>
    </div>
    <table>
      <thead><tr><th>ID</th><th>Name</th><th>Prefix</th><th>Role</th><th>Bot</th><th>Created</th><th>Last used</th><th></th></tr></thead>
      <tbody id="kRows"><tr><td colspan="8" class="muted">Loading…</td></tr></tbody>
    </table>
    <div class="msg" id="kMsg">Use: <code>curl -X POST $BASE/api/v1/messages -H "Authorization: Bearer mhk_…" -H "Content-Type: application/json" -d '{"to":"919xxxxxxxxx","text":"hi"}'</code></div>
  </div>
</main>

<footer>/health returns 503 while the socket is not open · watchdog restarts the process if it stays down</footer>

<script>
(function () {
  var KEY = "mahoraga_admin_token";
  var $ = function (id) { return document.getElementById(id); };
  var token = sessionStorage.getItem(KEY) || "";
  var timer = null;

  function fmt(ts) {
    if (!ts) return "—";
    var d = new Date(ts), diff = Math.round((Date.now() - ts) / 1000);
    var rel = diff < 60 ? diff + "s ago" : diff < 3600 ? Math.round(diff/60) + "m ago" : Math.round(diff/3600) + "h ago";
    return d.toLocaleString() + " (" + rel + ")";
  }
  function dur(sec) {
    var h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
    return (h ? h + "h " : "") + (m ? m + "m " : "") + s + "s";
  }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ "Authorization": "Bearer " + token }, opts.headers || {});
    opts.cache = "no-store";
    return fetch("/admin/api/" + path, opts);
  }

  function showLogin(msg) {
    $("dash").classList.add("hidden");
    $("login").classList.remove("hidden");
    $("loginMsg").textContent = msg || "";
    if (timer) { clearInterval(timer); timer = null; }
  }
  function showDash() {
    $("login").classList.add("hidden");
    $("dash").classList.remove("hidden");
    refresh();
    if (!timer) timer = setInterval(refresh, 5000);
  }

  function refresh() {
    api("status").then(function (r) {
      if (r.status === 401) { sessionStorage.removeItem(KEY); token = ""; showLogin("Bad token."); return null; }
      return r.json();
    }).then(function (s) {
      if (!s) return;
      var st = $("state"); st.textContent = s.state; st.className = "pill " + s.state;
      $("selfJid").textContent = s.selfJid || "—";
      $("uptime").textContent = dur(s.uptimeSec);
      $("lastOpen").textContent = fmt(s.lastOpenAt);
      $("lastClose").textContent = s.lastCloseAt ? fmt(s.lastCloseAt) + (s.lastCloseCode ? " · code " + s.lastCloseCode : "") : "—";
      $("lastIn").textContent = fmt(s.lastInboundAt);
      $("lastOut").textContent = fmt(s.lastOutboundAt);
      $("reconnects").textContent = s.reconnectAttempts;
      $("version").textContent = s.version || "—";
      if (s.qrAvailable) {
        // <img src> can't carry the Bearer header, so fetch the SVG as a blob.
        api("qr.svg").then(function (r) { return r.ok ? r.blob() : null; }).then(function (b) {
          if (!b) return;
          var img = $("qr").querySelector("img");
          if (!img) { $("qr").innerHTML = '<img alt="WhatsApp pairing QR">'; img = $("qr").querySelector("img"); }
          var old = img.src; img.src = URL.createObjectURL(b);
          if (old && old.indexOf("blob:") === 0) URL.revokeObjectURL(old);
        });
        $("qrMsg").textContent = "QR is " + s.qrAgeSec + "s old — Baileys rotates it every ~20s. Scan quickly.";
      } else {
        $("qr").innerHTML = '<span class="none">' + (s.state === "open" ? "No QR pending — session is linked." : "Waiting for socket… (" + s.state + ")") + "</span>";
        $("qrMsg").textContent = "QR refreshes automatically. Scan from WhatsApp → Linked devices.";
      }
    }).catch(function (e) { $("actionMsg").textContent = "Fetch failed: " + e; });
  }

  function act(path, confirmText) {
    if (confirmText && !confirm(confirmText)) return;
    api(path, { method: "POST" }).then(function (r) { return r.json(); }).then(function (j) {
      $("actionMsg").textContent = j.message || j.error || JSON.stringify(j);
    }).catch(function (e) { $("actionMsg").textContent = "Failed: " + e; });
  }

  $("loginBtn").onclick = function () {
    token = $("tok").value.trim();
    if (!token) return;
    sessionStorage.setItem(KEY, token);
    showDash();
  };
  $("tok").onkeydown = function (e) { if (e.key === "Enter") $("loginBtn").click(); };
  $("refreshBtn").onclick = refresh;
  $("restartBtn").onclick = function () { act("restart", "Restart the bot process? WhatsApp will reconnect in ~10–30s."); };
  $("relinkBtn").onclick = function () { act("relink", "Wipe the stored WhatsApp session and restart? You will need to scan a new QR."); };
  $("logoutBtn").onclick = function () { sessionStorage.removeItem(KEY); token = ""; showLogin(); };

  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function loadKeys() {
    api("keys").then(function (r) { return r.ok ? r.json() : r.json().then(function (e) { throw new Error(e.error || r.status); }); }).then(function (j) {
      var rows = j.keys.map(function (k) {
        var dead = !!k.revokedAt;
        return "<tr" + (dead ? ' style="opacity:.45"' : "") + "><td>" + k.id + "</td><td>" + esc(k.name) + "</td><td>" + esc(k.prefix) + "…</td><td>" + esc(k.role) + "</td><td>" + (k.botNumber == null ? "any" : k.botNumber) + "</td><td class='muted'>" + new Date(k.createdAt).toLocaleDateString() + "</td><td class='muted'>" + (k.lastUsedAt ? fmt(new Date(k.lastUsedAt).getTime()) : "never") + "</td><td>" + (dead ? "revoked" : '<button class="small danger" data-revoke="' + k.id + '">Revoke</button>') + "</td></tr>";
      });
      $("kRows").innerHTML = rows.length ? rows.join("") : '<tr><td colspan="8" class="muted">No keys yet.</td></tr>';
    }).catch(function (e) {
      $("kRows").innerHTML = '<tr><td colspan="8" class="muted">Could not load keys: ' + esc(e.message) + '</td></tr>';
    });
  }
  $("kCreate").onclick = function () {
    var name = $("kName").value.trim(); if (!name) { $("kMsg").textContent = "Name required."; return; }
    var bot = $("kBot").value.trim();
    api("keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name, role: $("kRole").value, botNumber: bot === "" ? null : Number(bot) }) })
      .then(function (r) { return r.json(); }).then(function (j) {
        if (j.key) { $("kNew").classList.remove("hidden"); $("kNewVal").textContent = j.key; $("kName").value = ""; $("kBot").value = ""; loadKeys(); }
        else $("kMsg").textContent = j.detail || j.error || "Failed";
      });
  };
  $("kRows").onclick = function (e) {
    var id = e.target && e.target.getAttribute && e.target.getAttribute("data-revoke");
    if (!id || !confirm("Revoke key #" + id + "? Scripts using it will start getting 401.")) return;
    api("keys/" + id, { method: "DELETE" }).then(function () { loadKeys(); });
  };
  var origShowDash = showDash;
  showDash = function () { origShowDash(); loadKeys(); };

  if (token) showDash(); else showLogin();
})();
</script>
</body>
</html>`;
}
