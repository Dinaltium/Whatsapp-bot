# MAHORAGA

**M**odular **A**utonomous **H**elper for **O**perations, **R**etrieval, **A**utomation & **G**eneral **A**ssistance — a TypeScript WhatsApp bot coordinator designed for the DK24 and ECB developer networks. It integrates with the Groq AI API (Llama-3.3-70B), Neon PostgreSQL for session persistence, a prompt-injection firewall, and the dk24.org public API for calendar, community, and project data.

## Key Features

- **Multiple Bot Profiles:**
  - **Bot 0 (Generic):** Default assistant for chats/groups with no specialised bot assigned — neutral, general-purpose help.
  - **Bot 1 (ECB):** ECB-specific bot answering questions about hardware, microcontrollers, and embedded systems.
  - **Bot 2 (DKB):** Community directory coordinator for mentor registrations, calendar events, and intake queries.
  - **Bot 3 (PARAG):** Technical assistant for general coding and hackathons.
- **Groq AI Integration:** Multi-turn chat sessions utilizing `llama-3.3-70b-versatile` with restricted prompts focusing on technical topics.
- **PostgreSQL Session Store:** Session state is saved in Neon PostgreSQL. Supports optional JWT encryption at rest to protect authorization tokens.
- **Sequential ID Administration:**
  - Plural and singular commands to list, add, edit, disable, or enable allowed groups and private chats.
  - Administration requires sequential primary IDs rather than raw JIDs (e.g. `!rmgroup -id 4` or `!editgroup -id 2 -b 2`).
  - EPHEMERAL-safe storage: Allowlist records are saved entirely in PostgreSQL, avoiding issues with temporary local files on platforms like Render.
- **Admin Confirmation Prompts:** Deletions, edits, and bot re-assignments require a `!YES` confirmation from the specific administrator who initiated the action.
- **DK24 Data Sync:** Fetches events, communities, and projects from the dk24.org public API (`/api/v1/calendar`, `/api/v1/communities`, `/api/v1/projects`) with 24h Neon-backed caching and in-flight de-duplication.
- **Security Protections:**
  - **RBAC Firewall:** Standard JIDs and `@lid` identifiers are resolved and checked against `ADMIN_JIDS` values.
  - **LID Resolver:** Resolves WhatsApp Localized Identifiers (`@lid`) to phone JIDs (`@s.whatsapp.net`) using metadata caches and socket update events.
  - **Rate Limits & Muting:** Controls message frequency per user/group and uses burst limits to prevent spam.

## Tech Stack

- **Runtime:** Node.js (v20+) with TypeScript
- **WhatsApp Client:** `@whiskeysockets/baileys` (v7.0.0-rc13)
- **Database client:** Neon PostgreSQL (using pg connection pooling)
- **AI Completion:** Groq API SDK
- **DK24 data source:** dk24.org public REST API (native `fetch`)

## Prerequisites

- Node.js (v20.x or higher)
- PostgreSQL database instance (such as Neon.tech)
- Groq Cloud API Key
- A WhatsApp account to link via QR code

## Environment Variables Setup

Copy `.env.example` to `.env` and set the following parameters:

```bash
cp .env.example .env
```

| Variable | Required | Description | Example |
| :--- | :--- | :--- | :--- |
| `GROQ_API_KEY` | **Yes** | Groq Cloud API Key | `gsk_xxxxxx...` |
| `GROQ_MODEL` | No | Llama model to invoke | `llama-3.3-70b-versatile` |
| `ADMIN_JIDS` | **Yes** | Comma-separated administrator JIDs | `919902849280@s.whatsapp.net` |
| `ALLOWED_GROUPS` | No | Initial allowed groups list | `1203630234567@g.us 1` |
| `ALLOWED_CHATS` | No | Initial allowed private chats list | `919902849280@s.whatsapp.net 2` |
| `DATABASE_URL` | **Yes** | Connection string for Neon PostgreSQL | `postgresql://user:pass@host/db?sslmode=require` |
| `AUTH_STATE_JWT_SECRET`| No | Encryption secret for DB auth state | `secure_secret_key` |
| `ALLOW_FROM_ME_MESSAGES`| No | Process commands sent from self | `true` |
| `PORT` | No | Port for health check endpoint | `3000` |

## Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Start Development Mode
Runs the coordinator locally with reloading enabled:
```bash
npm run dev
```
Scan the printed QR code using WhatsApp on your phone under Linked Devices.

### 3. Build and Run in Production
```bash
npm run build
npm start
```

## System Architecture

```mermaid
graph TD
    A[WhatsApp Message] -->|Baileys Socket| B(JID & LID Resolution Layer)
    B -->|Resolves @lid to phone JID| C{Admin Command Check}
    C -->|Yes| D[Admin Action Router]
    C -->|No| E{Allowlist Check}
    E -->|Muted/Disabled| F[Ignore Message]
    E -->|Active/Enabled| G{Rate Limiter}
    G -->|Muted/Burst Triggered| H[Mute Bot response]
    G -->|Allowed| I[Bot Prompt Selector]
    I -->|Bot 2 DKB| J[DK24 API Sync / Mentor DB]
    I -->|Bot 0/1/3| K[Groq AI Completion Engine]
    K -->|Replies via typing state| L[WhatsApp Send Socket]
```

### Database Schema

Database tables are generated automatically on startup:

```
wa_allowed_groups (Allowed groups registry)
├── id (SERIAL, Primary Key)
├── jid (TEXT, Unique, Not Null)
├── bot_number (INTEGER, default 0)
├── enabled (BOOLEAN, default TRUE)
└── added_at (TIMESTAMPTZ)

wa_allowed_chats (Allowed private chats registry)
├── id (SERIAL, Primary Key)
├── jid (TEXT, Unique, Not Null)
├── bot_number (INTEGER, default 0)
├── enabled (BOOLEAN, default TRUE)
└── added_at (TIMESTAMPTZ)

dk24_mentors (Mentor directory)
├── id (SERIAL, Primary Key)
├── name (TEXT, Not Null)
├── organization (TEXT)
├── expertise (TEXT)
├── description (TEXT)
├── linkedin/instagram/github/email/phone (TEXT)
└── created_at (TIMESTAMPTZ)

dk24_action_logs (Action logs registry)
├── id (SERIAL, Primary Key)
├── actor_jid (TEXT)
├── action_type (TEXT)
├── target_id (TEXT)
├── target_name (TEXT)
├── details (TEXT)
└── logged_at (TIMESTAMPTZ)
```

## Administrator Commands Reference

These commands are restricted to JIDs listed in `ADMIN_JIDS`. All commands must be prefixed with `!`.

### Allowlist & Bot Management
- `!addgroup <group_jid> [bot_number]`
  - Adds a group and assigns the designated bot profile. Starts as active.
- `!rmgroup -id <id_number>` (or `!removegroup`)
  - Removes a group from the allowlist using its database ID. Prompts with a `!YES` confirmation.
- `!listgroups` (or `!listgroup`)
  - Lists registered groups, database IDs, bot assignments, and enabled/disabled states.
- `!addchat <chat_jid> [bot_number]`
  - Adds a private chat to the allowlist.
- `!rmchat -id <id_number>` (or `!removechat`)
  - Removes a private chat from the allowlist by ID. Prompts with a `!YES` confirmation.
- `!listchats` (or `!listchat`)
  - Lists registered private chats, database IDs, bot assignments, and enabled/disabled states.
- `!editgroup -id <id_number> -b <bot_number>` / `!editchat -id <id_number> -b <bot_number>`
  - Changes the bot assigned to a group or chat. Alerts and skips if unchanged. Otherwise, prompts for `!YES` confirmation.
- `!disablegroup -id <id_number>` / `!disablechat -id <id_number>`
  - Sets the enabled status to `false`. The bot will ignore standard messages in this channel immediately without requesting confirmation.
- `!enablegroup -id <id_number>` / `!enablechat -id <id_number>`
  - Sets the enabled status to `true`, unmuting the bot.

### Database Utilities
- `!neonping`
  - Tests connections and database latency.
- `!neonconnect`
  - Shuts down the process with exit code 1 to let the environment manager (e.g. Render) restart the service.

## DKB (Bot 2) Directory & Intake Commands

Manage mentor registrations and profiles in the DK24 Directory.

- `!mentors [page]`
  - Displays a paginated list of mentors (10 records per page).
- `!mentor -id <id_number>`
  - Searches and displays detail cards for a mentor by ID.
- `!mentor -f <query> [page]`
  - Filters mentors by name, expertise area, or organization.
- `!addmentor -n <name> -o <org> [-d <desc>] [-ex <expert>] [-l <linkedin>] ...`
  - Adds a new mentor to the directory.
- `!editmentor -id <id_number> -<flag> <value>`
  - Modifies a field for a mentor record (supported flags: `-n`, `-o`, `-d`, `-ex`, `-l`, `-i`, `-g`, `-e`, `-p`).
- `!delmentor -id <id_number>`
  - Removes a mentor record by ID. Prompts with a `!YES` confirmation.

## DK24 Data Sync

Events, communities, and projects are pulled from the dk24.org public REST API
(`/api/v1/calendar`, `/api/v1/communities`, `/api/v1/projects`) using native
`fetch` — no browser/scraper involved. The base URL is overridable via
`DK24_API_BASE_URL`.
- **In-flight de-duplication:** Concurrent requests for the same resource reuse a single in-flight promise to avoid redundant API hits.
- **Caching:** Records are cached in Neon; a stale (>24h) cache is served instantly while a background refresh runs. A foreground fetch happens only when the cache table is empty.

## Ops: health, watchdog, admin dashboard

- `GET /health` → `200 {status:"ok"}` only while the WhatsApp socket is open; otherwise `503 {status:"degraded", state}`. Point Render's health check / UptimeRobot here so a dead WA link reads as down.
- **Watchdog** (`WATCHDOG_STALE_MS`, default 5 min): if the socket hasn't been open for that long — and we're not logged-out or mid-QR — the process exits 1 so the platform restarts it. A hung "connecting" socket no longer strands the bot.
- **Admin dashboard** at `/admin`, enabled by setting `ADMIN_TOKEN`. Shows session state, self JID, last inbound/outbound, reconnect count, and renders the pairing QR in-browser (no more scanning from logs). Buttons: *Restart process*, *Wipe session & relink*. API is Bearer-token gated with constant-time compare and per-IP lockout after 10 bad attempts.

## Public REST API (`/api/v1`)

Send through MAHORAGA from scripts, n8n, cron — without a second WhatsApp client. Every send takes the exact same path as a chat reply (`sendBotReply`): per-recipient cap, global account cap, typing delay, secret scrub. There is no bypass.

Create keys in the dashboard (`/admin` → API keys). Keys are `mhk_…`, shown once, stored hashed. Role `operator` can send; `viewer` is read-only. Optional bot-number scope restricts a key to that bot's allowlisted chats. `ADMIN_TOKEN` also works as an unscoped operator.

| Method | Path | Body / notes |
|---|---|---|
| `POST` | `/api/v1/messages` | `{"to":"<jid or phone>","text":"…"}` → `202 {accepted}`. Target must be allowlisted (or an admin JID). |
| `GET` | `/api/v1/status` | socket state, last in/out |
| `GET` | `/api/v1/groups` · `/chats` | allowlist rows visible to the key's scope |

```bash
curl -X POST https://<service>.onrender.com/api/v1/messages   -H "Authorization: Bearer mhk_…" -H "Content-Type: application/json"   -d '{"to":"120363xxxxx@g.us","text":"Standup in 10."}'
```

Errors: `401` bad key · `403 recipient_not_allowlisted | recipient_disabled | bot_scope_mismatch | forbidden` · `429` per-key throttle (`API_REQUESTS_PER_MIN`) · `503 socket_not_open`.

## Deployment (Render)

Node runtime (no Docker needed — `ffmpeg-static` ships the binary). Build `npm ci && npm run build`, start `npm start`. Do **not** set `PORT`; Render injects it. Set health check path to `/health`. Free tier sleeps after 15 min idle and drops the WA socket — use a Background Worker / Starter plan, or an external pinger on `/health`.

## Deployment (VPS)

Runs on a plain VPS (Docker or a Node process manager).

1. Pull the latest code on the server: `git pull`.
2. Ensure the environment is configured (a `.env` file or exported vars). At
   minimum: `GROQ_API_KEY`, `ADMIN_JIDS`, `DATABASE_URL` (Neon), `REDIS_URL`,
   and **`AUTH_STATE_KEY`** — the bot fails to start without an auth-state
   encryption key unless `ALLOW_UNENCRYPTED_AUTH_STATE=true`. See
   `.env.example` for the full list.
3. Build and start:
   - **Docker:** `docker build -t whatsapp-bot . && docker run --env-file .env whatsapp-bot`
   - **Direct:** `npm install && npm run build && npm start` (keep it alive with
     pm2/systemd).
4. Schema and the one-time bot-number migration apply automatically on boot via
   `ensureSchema` / `migrateParagToBot3`.

## Security Policies

1. **Firewall Filtering:** Prompts are monitored to prevent roleplay bypasses or jailbreaks.
2. **Secrets Protection:** Always use environment parameters to store connection strings and credentials.
3. **Database Audit Logs:** State changes to allowlists and mentor records are logged with the actor's JID, action type, target ID, and modifications.
