/**
 * Admin dashboard — one HTML document, vanilla JS, served by the health
 * server. No framework, no build step, nothing extra in the container.
 *
 * Auth: the page asks for ADMIN_TOKEN once, keeps it in sessionStorage, and
 * sends it as a Bearer header on every /admin/api call. The HTML itself is
 * public but holds nothing sensitive; every data call is gated server-side.
 *
 * Design notes: one hero slot (the wheel, or the QR when pairing is needed)
 * carries the state; everything below is quiet tables. Mono is used only for
 * machine identifiers (JIDs, keys). Motion is limited to the wheel turning
 * while connecting, and is disabled under prefers-reduced-motion.
 */
export function renderAdminPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MAHORAGA</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:ital,wght@0,400;0,500;0,600;1,400&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --paper:#E9EDF1; --chalk:#FFFFFF; --ink:#101828; --mist:#667085; --rule:#D0D5DD; --rule-soft:#E4E7EC;
    --harbour:#0F6E63; --harbour-soft:#E3F1EE; --turmeric:#C2740B; --turmeric-soft:#FBF0DE; --laterite:#B42318; --laterite-soft:#FBE9E7;
    --sans:"Instrument Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
    --mono:"JetBrains Mono", ui-monospace, Consolas, monospace;
  }
  * { box-sizing:border-box; }
  html { background:var(--paper); }
  body { margin:0; color:var(--ink); font:15px/1.5 var(--sans); font-feature-settings:"tnum" 1; -webkit-font-smoothing:antialiased; }
  a { color:var(--harbour); }
  button, input, select { font:inherit; color:inherit; }
  button { cursor:pointer; background:none; border:1px solid var(--rule); border-radius:4px; padding:6px 12px; line-height:1.3; }
  button:hover { border-color:var(--ink); }
  button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible { outline:2px solid var(--harbour); outline-offset:2px; }
  button.primary { background:var(--ink); color:var(--chalk); border-color:var(--ink); }
  button.primary:hover { background:#000; }
  button.quiet { border-color:transparent; padding:6px 8px; color:var(--mist); }
  button.quiet:hover { color:var(--ink); border-color:transparent; text-decoration:underline; }
  button.danger { color:var(--laterite); }
  td.actions button.quiet.danger { color:var(--mist); }
  td.actions button.quiet.danger:hover { color:var(--laterite); }
  button.danger:hover { border-color:var(--laterite); }
  button:disabled { opacity:.45; cursor:default; }
  input, select { background:var(--chalk); border:1px solid var(--rule); border-radius:4px; padding:7px 10px; }
  select { padding-right:28px; }
  .mono { font-family:var(--mono); font-size:.86em; }
  .muted { color:var(--mist); }
  .hidden { display:none !important; }

  .wrap { max-width:1080px; margin:0 auto; padding:0 20px 80px; }
  header.top { display:flex; align-items:baseline; justify-content:space-between; gap:16px; padding:22px 0 14px; flex-wrap:wrap; }
  header.top h1 { margin:0; font-size:17px; font-weight:600; letter-spacing:.02em; }
  header.top h1 span { font-weight:400; color:var(--mist); margin-left:10px; font-size:14px; letter-spacing:0; }
  header.top .tools { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }

  /* Login */
  #login { max-width:400px; margin:14vh auto 0; background:var(--chalk); border:1px solid var(--rule); border-radius:6px; padding:24px; }
  #login h2 { margin:0 0 4px; font-size:17px; font-weight:600; }
  #login p { margin:0 0 16px; color:var(--mist); font-size:14px; }
  #login input { width:100%; margin-bottom:10px; }

  /* Hero */
  .hero { background:var(--chalk); border:1px solid var(--rule); border-radius:6px; padding:26px 28px; display:grid; grid-template-columns:200px 1fr; gap:28px; align-items:center; }
  @media (max-width:640px) { .hero { grid-template-columns:1fr; justify-items:center; text-align:center; padding:22px 18px; } }
  .gauge { width:200px; height:200px; position:relative; }
  .gauge svg { width:100%; height:100%; display:block; }
  .gauge .ring { fill:none; stroke-width:10; stroke:var(--rule-soft); }
  .gauge .arc { fill:none; stroke-width:10; stroke-linecap:round; stroke:var(--mist); transition:stroke .3s; }
  .gauge .spokes { stroke:var(--rule); stroke-width:2; transform-origin:100px 100px; }
  .gauge .hub { fill:var(--chalk); stroke:var(--rule); stroke-width:2; }
  .gauge.open .arc { stroke:var(--harbour); }
  .gauge.connecting .arc, .gauge.starting .arc { stroke:var(--turmeric); }
  .gauge.closed .arc, .gauge.logged_out .arc { stroke:var(--laterite); }
  .gauge.connecting .spokes, .gauge.starting .spokes { animation:turn 9s linear infinite; }
  @keyframes turn { to { transform:rotate(360deg); } }
  @media (prefers-reduced-motion:reduce) { .gauge .spokes { animation:none !important; } }
  .gauge .centre { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; }
  .gauge .big { font-size:40px; font-weight:600; line-height:1; letter-spacing:-.02em; }
  .gauge .small { font-size:12px; color:var(--mist); margin-top:6px; max-width:120px; line-height:1.3; }
  .facts h2 { margin:0 0 6px; font-size:22px; font-weight:600; letter-spacing:-.01em; }
  .facts h2 .state { display:inline-block; margin-left:10px; font-size:13px; font-weight:500; padding:2px 9px; border-radius:999px; vertical-align:middle; }
  .state.open { background:var(--harbour-soft); color:var(--harbour); }
  .state.connecting, .state.starting { background:var(--turmeric-soft); color:var(--turmeric); }
  .state.closed, .state.logged_out { background:var(--laterite-soft); color:var(--laterite); }
  .facts p { margin:0 0 4px; color:var(--mist); }
  .facts p b { color:var(--ink); font-weight:500; }
  .facts .warn { color:var(--laterite); }
  .qr { width:200px; height:200px; background:#fff; border:1px solid var(--rule); border-radius:6px; display:flex; align-items:center; justify-content:center; }
  .qr img { width:188px; height:188px; image-rendering:pixelated; }

  /* Sections */
  section.list { margin-top:34px; }
  .sechead { display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:10px; flex-wrap:wrap; }
  .sechead h2 { margin:0; font-size:17px; font-weight:600; }
  .sechead h2 small { color:var(--mist); font-weight:400; margin-left:8px; }
  .sechead .hint { color:var(--mist); font-size:13px; flex-basis:100%; margin-top:-4px; }
  table { width:100%; border-collapse:collapse; background:var(--chalk); border:1px solid var(--rule); border-radius:6px; overflow:hidden; }
  th, td { text-align:left; padding:10px 12px; border-top:1px solid var(--rule-soft); vertical-align:middle; }
  thead th { border-top:0; color:var(--mist); font-weight:500; font-size:13px; }
  td .sub { display:block; color:var(--mist); font-size:12px; margin-top:2px; }
  td.num { width:1%; white-space:nowrap; }
  td.actions { text-align:right; white-space:nowrap; width:1%; }
  tr.off td:first-child { color:var(--mist); }
  td select { padding:4px 26px 4px 8px; }
  .toggle { display:inline-flex; align-items:center; gap:6px; cursor:pointer; }
  .toggle input { accent-color:var(--harbour); width:16px; height:16px; margin:0; }
  .empty td { color:var(--mist); padding:18px 12px; }

  /* Inline panels */
  .panel { background:var(--chalk); border:1px solid var(--rule); border-radius:6px; padding:14px 16px; margin-bottom:10px; }
  .panel .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .panel .row input { flex:1 1 200px; }
  .panel p { margin:0 0 10px; color:var(--mist); font-size:14px; }
  .panel table { border:0; border-top:1px solid var(--rule-soft); border-radius:0; margin-top:10px; }
  .keyreveal { margin-top:10px; padding:10px 12px; border:1px dashed var(--harbour); border-radius:4px; background:var(--harbour-soft); }
  .keyreveal code { display:block; margin-top:4px; word-break:break-all; user-select:all; }
  .flash { font-size:13px; color:var(--mist); min-height:18px; margin-top:8px; }
  .flash.err { color:var(--laterite); }
  .flash.ok { color:var(--harbour); }
  @media (max-width:640px) { th.hide-sm, td.hide-sm { display:none; } td, th { padding:9px 8px; } section.list, .panel { overflow-x:auto; } table { min-width:480px; } }
</style>
</head>
<body>
<div class="wrap">

<section id="login" class="hidden">
  <h2>MAHORAGA</h2>
  <p>Enter the admin token to open the console.</p>
  <input id="tok" type="password" placeholder="Admin token" autocomplete="current-password" aria-label="Admin token">
  <button id="loginBtn" class="primary">Open console</button>
  <div class="flash" id="loginMsg"></div>
</section>

<div id="app" class="hidden">
  <header class="top">
    <h1>MAHORAGA <span id="buildTag"></span></h1>
    <div class="tools">
      <button id="refreshBtn" class="quiet">Refresh</button>
      <button id="restartBtn">Restart bot</button>
      <button id="relinkBtn" class="danger">Unlink and pair again</button>
      <button id="logoutBtn" class="quiet">Forget token</button>
    </div>
  </header>

  <section class="hero" aria-live="polite">
    <div id="heroSlot">
      <div class="gauge" id="gauge">
        <svg viewBox="0 0 200 200" aria-hidden="true">
          <g class="spokes" id="spokes"></g>
          <circle class="ring" cx="100" cy="100" r="88"/>
          <circle class="arc" id="arc" cx="100" cy="100" r="88" stroke-dasharray="553" stroke-dashoffset="553" transform="rotate(-90 100 100)"/>
          <circle class="hub" cx="100" cy="100" r="62"/>
        </svg>
        <div class="centre"><div class="big" id="bigNum">—</div><div class="small" id="bigLabel">waiting for status</div></div>
      </div>
    </div>
    <div class="facts">
      <h2 id="headline">Connecting…<span class="state" id="statePill"></span></h2>
      <p id="factMsgs"></p>
      <p id="factUp"></p>
      <p id="factModels"></p>
      <div class="flash" id="actionMsg"></div>
    </div>
  </section>

  <section class="list" id="secGroups">
    <div class="sechead">
      <h2>Groups <small id="grpCount"></small></h2>
      <button id="addGroupBtn">Add a group</button>
      <div class="hint">Groups the bot answers in. The bot column decides which persona replies.</div>
    </div>
    <div class="panel hidden" id="addGroupPanel">
      <p>Groups this number is a member of but the bot ignores. Pick a bot and add.</p>
      <div class="row"><input id="grpManual" placeholder="or paste a group JID (…@g.us)"><select id="grpManualBot"></select><button id="grpManualAdd">Add</button><button id="addGroupClose" class="quiet">Close</button></div>
      <table><thead><tr><th>Group</th><th class="hide-sm">Members</th><th>Bot</th><th></th></tr></thead><tbody id="discRows"><tr class="empty"><td colspan="4">Loading groups from WhatsApp…</td></tr></tbody></table>
      <div class="flash" id="grpAddMsg"></div>
    </div>
    <table>
      <thead><tr><th>Group</th><th>Bot</th><th>Active</th><th></th></tr></thead>
      <tbody id="grpRows"><tr class="empty"><td colspan="4">Loading…</td></tr></tbody>
    </table>
    <div class="flash" id="grpMsg"></div>
  </section>

  <section class="list" id="secChats">
    <div class="sechead">
      <h2>Direct chats <small id="chatCount"></small></h2>
      <button id="addChatBtn">Add a number</button>
      <div class="hint">People the bot replies to in private. Admins are always allowed and don't need to be here.</div>
    </div>
    <div class="panel hidden" id="addChatPanel">
      <div class="row"><input id="chatNum" placeholder="Phone with country code, e.g. 919902849280" inputmode="numeric"><select id="chatBot"></select><button id="chatAdd">Add</button><button id="addChatClose" class="quiet">Close</button></div>
      <div class="flash" id="chatAddMsg"></div>
    </div>
    <table>
      <thead><tr><th>Number</th><th>Bot</th><th>Active</th><th></th></tr></thead>
      <tbody id="chatRows"><tr class="empty"><td colspan="4">Loading…</td></tr></tbody>
    </table>
    <div class="flash" id="chatMsg"></div>
  </section>

  <section class="list" id="secKeys">
    <div class="sechead">
      <h2>API keys <small id="keyCount"></small></h2>
      <button id="addKeyBtn">Create key</button>
      <div class="hint">For scripts that send through the bot at <span class="mono">POST /api/v1/messages</span>. Operator keys can send; viewer keys can only read.</div>
    </div>
    <div class="panel hidden" id="addKeyPanel">
      <div class="row"><input id="kName" placeholder="Name, e.g. n8n standup reminder"><select id="kRole"><option value="operator">Operator: can send</option><option value="viewer">Viewer: read only</option></select><select id="kBot"></select><button id="kCreate">Create</button><button id="addKeyClose" class="quiet">Close</button></div>
      <div class="keyreveal hidden" id="kNew">Copy this key now. It won't be shown again.<code class="mono" id="kNewVal"></code></div>
      <div class="flash" id="kAddMsg"></div>
    </div>
    <table>
      <thead><tr><th>Name</th><th>Role</th><th>Bot</th><th class="hide-sm">Last used</th><th></th></tr></thead>
      <tbody id="kRows"><tr class="empty"><td colspan="5">Loading…</td></tr></tbody>
    </table>
    <div class="flash" id="kMsg"></div>
  </section>
</div>
</div>

<script>
(function () {
  var KEY = "mahoraga_admin_token";
  var $ = function (id) { return document.getElementById(id); };
  var token = sessionStorage.getItem(KEY) || "";
  var timer = null;
  var bots = { 0: "Generic" };
  var groupNames = {}; // jid -> subject, filled from discovery

  // ── utilities ─────────────────────────────────────────────────────
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function ago(ts) {
    if (!ts) return null;
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + " second" + (s === 1 ? "" : "s");
    var m = Math.round(s / 60); if (m < 60) return m + " minute" + (m === 1 ? "" : "s");
    var h = Math.round(m / 60); if (h < 48) return h + " hour" + (h === 1 ? "" : "s");
    return Math.round(h / 24) + " days";
  }
  function agoShort(ts) {
    if (!ts) return "—";
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + "s"; var m = Math.round(s / 60); if (m < 60) return m + "m";
    var h = Math.round(m / 60); if (h < 48) return h + "h"; return Math.round(h / 24) + "d";
  }
  function dur(sec) {
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    if (h >= 48) return Math.floor(h / 24) + " days";
    if (h) return h + "h " + m + "m";
    return m + "m";
  }
  function phone(jid) { return String(jid || "").replace(/@.*$/, "").replace(/:.*$/, ""); }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ "Authorization": "Bearer " + token }, opts.headers || {});
    if (opts.body && typeof opts.body !== "string") { opts.body = JSON.stringify(opts.body); opts.headers["Content-Type"] = "application/json"; }
    opts.cache = "no-store";
    return fetch("/admin/api/" + path, opts).then(function (r) {
      if (r.status === 401) { sessionStorage.removeItem(KEY); token = ""; showLogin("That token was refused."); throw new Error("unauthorized"); }
      return r;
    });
  }
  function apiJson(path, opts) {
    return api(path, opts).then(function (r) { return r.json().then(function (j) { if (!r.ok) { var e = new Error(j.detail || j.error || ("HTTP " + r.status)); e.code = j.error; throw e; } return j; }); });
  }
  function flash(id, text, kind) { var el = $(id); el.textContent = text || ""; el.className = "flash" + (kind ? " " + kind : ""); }
  function botOptions(selected, allowAny) {
    var out = allowAny ? '<option value="">Any bot</option>' : "";
    Object.keys(bots).sort(function (a, b) { return a - b; }).forEach(function (n) {
      out += '<option value="' + n + '"' + (String(selected) === String(n) ? " selected" : "") + ">" + esc(bots[n]) + " (" + n + ")</option>";
    });
    return out;
  }
  function botName(n) { return bots[n] ? bots[n] : "Bot " + n; }

  // ── views ─────────────────────────────────────────────────────────
  function showLogin(msg) {
    $("app").classList.add("hidden"); $("login").classList.remove("hidden");
    flash("loginMsg", msg, msg ? "err" : ""); $("tok").focus();
    if (timer) { clearInterval(timer); timer = null; }
  }
  function showApp() {
    $("login").classList.add("hidden"); $("app").classList.remove("hidden");
    refresh(); primeGroupNames(); loadChats(); loadKeys();
    if (!timer) timer = setInterval(refresh, 5000);
  }

  // eight spokes, drawn once
  (function drawSpokes() {
    var g = $("spokes"), out = "";
    for (var i = 0; i < 8; i++) {
      var a = (i * Math.PI) / 4, x1 = 100 + Math.cos(a) * 62, y1 = 100 + Math.sin(a) * 62, x2 = 100 + Math.cos(a) * 88, y2 = 100 + Math.sin(a) * 88;
      out += '<line x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1) + '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) + '"/>';
    }
    g.innerHTML = out;
  })();

  var lastStatus = null;
  function refresh() {
    apiJson("status").then(function (s) {
      lastStatus = s;
      if (s.bots) bots = s.bots;
      $("buildTag").textContent = s.version ? "build " + s.version : "";
      var pill = $("statePill"); pill.textContent = s.state.replace("_", " "); pill.className = "state " + s.state;
      $("gauge").className = "gauge " + s.state;

      // arc: fill = freshness of last inbound (full at 0s, empty at 1h); when down, full red
      var fill = 0;
      if (s.state === "open") { var age = s.lastInboundAt ? (Date.now() - s.lastInboundAt) / 3600000 : 1; fill = Math.max(0.04, 1 - Math.min(1, age)); }
      else if (s.state === "closed" || s.state === "logged_out") fill = 1;
      else fill = 0.25;
      $("arc").setAttribute("stroke-dashoffset", String(Math.round(553 * (1 - fill))));

      if (s.qrAvailable) {
        if (!$("qrImg")) $("heroSlot").innerHTML = '<div class="qr"><img id="qrImg" alt="WhatsApp pairing QR code"></div>';
        api("qr.svg").then(function (r) { return r.ok ? r.blob() : null; }).then(function (b) {
          if (!b) return; var img = $("qrImg"); if (!img) return;
          var old = img.src; img.src = URL.createObjectURL(b); if (old && old.indexOf("blob:") === 0) URL.revokeObjectURL(old);
        });
        $("headline").firstChild.nodeValue = "Scan to link a phone";
        $("factMsgs").textContent = "WhatsApp → Linked devices → Link a device. The code is " + s.qrAgeSec + "s old and refreshes about every 20 seconds.";
      } else {
        if ($("qrImg")) location.reload(); // back from pairing: simplest way to restore the gauge markup
        $("bigNum").textContent = s.lastInboundAt ? agoShort(s.lastInboundAt) : "—";
        $("bigLabel").textContent = s.lastInboundAt ? "since last message" : "no messages yet";
        var who = s.selfJid ? "Linked as " + phone(s.selfJid) : (s.state === "logged_out" ? "Logged out" : "Not linked");
        $("headline").firstChild.nodeValue = who;
        var parts = [];
        if (s.lastInboundAt) parts.push("Last message " + ago(s.lastInboundAt) + " ago.");
        if (s.lastOutboundAt) parts.push("Replied " + ago(s.lastOutboundAt) + " ago.");
        if (!parts.length) parts.push(s.state === "open" ? "Waiting for the first message." : "Not receiving messages.");
        $("factMsgs").textContent = parts.join(" ");
      }
      var up = "Up " + dur(s.uptimeSec) + ". ";
      up += s.reconnectAttempts ? s.reconnectAttempts + " reconnect" + (s.reconnectAttempts === 1 ? "" : "s") + " this run." : "No reconnects.";
      if (s.lastCloseAt && s.state !== "open") up += " Last drop " + ago(s.lastCloseAt) + " ago" + (s.lastCloseCode ? " (code " + s.lastCloseCode + ")" : "") + ".";
      $("factUp").textContent = up;
      var fm = $("factModels"); fm.className = "";
      if (!s.models) fm.textContent = "";
      else if (s.models.error) fm.textContent = "Couldn't verify models: " + s.models.error;
      else { var bad = s.models.models.filter(function (m) { return !m.ok; }); if (bad.length) { fm.className = "warn"; fm.textContent = "Groq no longer serves " + bad.map(function (m) { return m.id; }).join(", ") + ". Change GROQ_MODEL." } else fm.textContent = "Models OK."; }
    }).catch(function (e) { if (e.message !== "unauthorized") flash("actionMsg", "Couldn't reach the bot: " + e.message, "err"); });
  }

  function act(path, confirmText) {
    if (confirmText && !confirm(confirmText)) return;
    apiJson(path, { method: "POST" }).then(function (j) { flash("actionMsg", j.message || "Done.", "ok"); })
      .catch(function (e) { flash("actionMsg", e.message, "err"); });
  }

  // ── allowlists ────────────────────────────────────────────────────
  function rowFor(kind, e) {
    var label = kind === "groups" ? (groupNames[e.jid] || "Group") : phone(e.jid);
    var sub = kind === "groups" ? e.jid : e.jid;
    return '<tr data-id="' + e.id + '" class="' + (e.enabled ? "" : "off") + '">' +
      '<td>' + esc(label) + '<span class="sub mono">' + esc(sub) + '</span></td>' +
      '<td class="num"><select data-act="bot" aria-label="Bot for ' + esc(label) + '">' + botOptions(e.botNumber, false) + '</select></td>' +
      '<td class="num"><label class="toggle"><input type="checkbox" data-act="on"' + (e.enabled ? " checked" : "") + ' aria-label="Active"><span class="muted">' + (e.enabled ? "on" : "off") + '</span></label></td>' +
      '<td class="actions"><button class="quiet danger" data-act="rm">Remove</button></td></tr>';
  }
  function loadList(kind, rowsId, countId, msgId) {
    apiJson(kind).then(function (j) {
      var rows = j[kind];
      $(countId).textContent = rows.length ? rows.length : "";
      $(rowsId).innerHTML = rows.length ? rows.map(function (e) { return rowFor(kind, e); }).join("") :
        '<tr class="empty"><td colspan="4">' + (kind === "groups" ? "The bot isn't answering in any group yet. Add one above." : "No private chats allowed yet.") + '</td></tr>';
    }).catch(function (e) { $(rowsId).innerHTML = '<tr class="empty"><td colspan="4">Couldn't load this list.</td></tr>'; flash(msgId, e.message, "err"); });
  }
  function loadGroups() { loadList("groups", "grpRows", "grpCount", "grpMsg"); }
  // Fetch group subjects from WhatsApp once so the table shows names, not just JIDs.
  function primeGroupNames() {
    apiJson("discover/groups").then(function (j) { j.groups.forEach(function (g) { groupNames[g.jid] = g.subject; }); })
      .catch(function () { /* socket down: JIDs only */ })
      .then(loadGroups);
  }
  function loadChats() { loadList("chats", "chatRows", "chatCount", "chatMsg"); }

  function bindList(kind, rowsId, msgId, reload) {
    $(rowsId).addEventListener("change", function (ev) {
      var t = ev.target, tr = t.closest("tr"); if (!tr) return; var id = tr.getAttribute("data-id");
      if (t.getAttribute("data-act") === "bot") {
        apiJson(kind + "/" + id, { method: "PATCH", body: { botNumber: Number(t.value) } }).then(function () { flash(msgId, "Bot changed.", "ok"); }).catch(function (e) { flash(msgId, e.message, "err"); reload(); });
      }
      if (t.getAttribute("data-act") === "on") {
        apiJson(kind + "/" + id, { method: "PATCH", body: { enabled: t.checked } }).then(function () { flash(msgId, t.checked ? "Turned on." : "Turned off.", "ok"); reload(); }).catch(function (e) { flash(msgId, e.message, "err"); reload(); });
      }
    });
    $(rowsId).addEventListener("click", function (ev) {
      var t = ev.target; if (t.getAttribute("data-act") !== "rm") return;
      var tr = t.closest("tr"), id = tr.getAttribute("data-id"), name = tr.querySelector("td").firstChild.nodeValue;
      if (!confirm("Remove " + name + "? The bot will stop answering there.")) return;
      apiJson(kind + "/" + id, { method: "DELETE" }).then(function () { flash(msgId, "Removed.", "ok"); reload(); }).catch(function (e) { flash(msgId, e.message, "err"); });
    });
  }
  bindList("groups", "grpRows", "grpMsg", loadGroups);
  bindList("chats", "chatRows", "chatMsg", loadChats);

  // group discovery panel
  function loadDiscovery() {
    $("grpManualBot").innerHTML = botOptions(0, false);
    $("discRows").innerHTML = '<tr class="empty"><td colspan="4">Loading groups from WhatsApp…</td></tr>';
    apiJson("discover/groups").then(function (j) {
      j.groups.forEach(function (g) { groupNames[g.jid] = g.subject; });
      loadGroups(); // now we have names
      var un = j.groups.filter(function (g) { return !g.allowlisted; });
      $("discRows").innerHTML = un.length ? un.map(function (g) {
        return '<tr data-jid="' + esc(g.jid) + '"><td>' + esc(g.subject || "Untitled group") + '<span class="sub mono">' + esc(g.jid) + '</span></td><td class="num hide-sm">' + g.size + '</td><td class="num"><select data-role="bot">' + botOptions(0, false) + '</select></td><td class="actions"><button data-role="add">Add</button></td></tr>';
      }).join("") : '<tr class="empty"><td colspan="4">Every group this number is in is already listed.</td></tr>';
    }).catch(function (e) {
      $("discRows").innerHTML = '<tr class="empty"><td colspan="4">' + (e.code === "socket_not_open" ? "WhatsApp isn't connected, so groups can't be listed. Paste a JID above instead." : "Couldn't list groups: " + esc(e.message)) + '</td></tr>';
    });
  }
  $("discRows").addEventListener("click", function (ev) {
    var t = ev.target; if (t.getAttribute("data-role") !== "add") return;
    var tr = t.closest("tr"), jid = tr.getAttribute("data-jid"), bot = Number(tr.querySelector("select").value);
    t.disabled = true;
    apiJson("groups", { method: "POST", body: { jid: jid, botNumber: bot } }).then(function () { flash("grpAddMsg", "Added.", "ok"); tr.remove(); loadGroups(); }).catch(function (e) { flash("grpAddMsg", e.message, "err"); t.disabled = false; });
  });
  $("grpManualAdd").onclick = function () {
    var jid = $("grpManual").value.trim(); if (!jid) return;
    apiJson("groups", { method: "POST", body: { jid: jid, botNumber: Number($("grpManualBot").value) } }).then(function () { flash("grpAddMsg", "Added.", "ok"); $("grpManual").value = ""; loadGroups(); }).catch(function (e) { flash("grpAddMsg", e.message, "err"); });
  };
  $("addGroupBtn").onclick = function () { $("addGroupPanel").classList.toggle("hidden"); if (!$("addGroupPanel").classList.contains("hidden")) loadDiscovery(); };
  $("addGroupClose").onclick = function () { $("addGroupPanel").classList.add("hidden"); };

  // chats panel
  $("addChatBtn").onclick = function () { $("chatBot").innerHTML = botOptions(0, false); $("addChatPanel").classList.toggle("hidden"); $("chatNum").focus(); };
  $("addChatClose").onclick = function () { $("addChatPanel").classList.add("hidden"); };
  $("chatAdd").onclick = function () {
    var n = $("chatNum").value.trim(); if (!n) return;
    apiJson("chats", { method: "POST", body: { jid: n, botNumber: Number($("chatBot").value) } }).then(function (j) { flash("chatAddMsg", "Added " + phone(j.jid) + ".", "ok"); $("chatNum").value = ""; loadChats(); }).catch(function (e) { flash("chatAddMsg", e.message, "err"); });
  };
  $("chatNum").onkeydown = function (e) { if (e.key === "Enter") $("chatAdd").click(); };

  // ── keys ──────────────────────────────────────────────────────────
  function loadKeys() {
    apiJson("keys").then(function (j) {
      var live = j.keys.filter(function (k) { return !k.revokedAt; });
      $("keyCount").textContent = live.length ? live.length : "";
      $("kRows").innerHTML = j.keys.length ? j.keys.map(function (k) {
        var dead = !!k.revokedAt;
        return '<tr' + (dead ? ' class="off"' : "") + '><td>' + esc(k.name) + '<span class="sub mono">' + esc(k.prefix) + '…</span></td><td>' + esc(k.role) + '</td><td>' + (k.botNumber == null ? "Any" : esc(botName(k.botNumber))) + '</td><td class="hide-sm muted">' + (k.lastUsedAt ? ago(new Date(k.lastUsedAt).getTime()) + " ago" : "Never") + '</td><td class="actions">' + (dead ? '<span class="muted">Revoked</span>' : '<button class="quiet danger" data-revoke="' + k.id + '">Revoke</button>') + '</td></tr>';
      }).join("") : '<tr class="empty"><td colspan="5">No keys yet. Create one to let a script send through the bot.</td></tr>';
    }).catch(function (e) { $("kRows").innerHTML = '<tr class="empty"><td colspan="5">Couldn't load keys.</td></tr>'; flash("kMsg", e.message, "err"); });
  }
  $("addKeyBtn").onclick = function () { $("kBot").innerHTML = botOptions("", true); $("addKeyPanel").classList.toggle("hidden"); $("kName").focus(); };
  $("addKeyClose").onclick = function () { $("addKeyPanel").classList.add("hidden"); $("kNew").classList.add("hidden"); };
  $("kCreate").onclick = function () {
    var name = $("kName").value.trim(); if (!name) { flash("kAddMsg", "Give the key a name.", "err"); return; }
    var bot = $("kBot").value;
    apiJson("keys", { method: "POST", body: { name: name, role: $("kRole").value, botNumber: bot === "" ? null : Number(bot) } })
      .then(function (j) { $("kNew").classList.remove("hidden"); $("kNewVal").textContent = j.key; $("kName").value = ""; flash("kAddMsg", ""); loadKeys(); })
      .catch(function (e) { flash("kAddMsg", e.message, "err"); });
  };
  $("kRows").addEventListener("click", function (ev) {
    var id = ev.target.getAttribute && ev.target.getAttribute("data-revoke"); if (!id) return;
    if (!confirm("Revoke this key? Anything using it will start getting 401.")) return;
    apiJson("keys/" + id, { method: "DELETE" }).then(function () { flash("kMsg", "Revoked.", "ok"); loadKeys(); }).catch(function (e) { flash("kMsg", e.message, "err"); });
  });

  // ── top bar ───────────────────────────────────────────────────────
  $("loginBtn").onclick = function () { token = $("tok").value.trim(); if (!token) return; sessionStorage.setItem(KEY, token); showApp(); };
  $("tok").addEventListener("keydown", function (e) { if (e.key === "Enter") $("loginBtn").click(); });
  $("refreshBtn").onclick = function () { refresh(); loadGroups(); loadChats(); loadKeys(); };
  $("restartBtn").onclick = function () { act("restart", "Restart the bot? WhatsApp reconnects in about 20 seconds."); };
  $("relinkBtn").onclick = function () { act("relink", "Unlink this phone and wipe the session? You'll scan a new QR code here afterwards."); };
  $("logoutBtn").onclick = function () { sessionStorage.removeItem(KEY); token = ""; showLogin(); };

  if (token) showApp(); else showLogin();
})();
</script>
</body>
</html>`;
}
