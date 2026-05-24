# WhatsApp Bot Coordinator

A TypeScript-based WhatsApp bot coordinator designed for the DK24 and ECB developer networks. It integrates with the Groq AI API (Llama-3.3-70B), Neon PostgreSQL for session persistence, a prompt-injection firewall, and Puppeteer for calendar updates.

## Key Features

- **Multiple Bot Profiles:**
  - **Bot 0 (PARAG):** Technical assistant for general coding and hackathons.
  - **Bot 1 (ECB):** ECB-specific bot answering questions about hardware, microcontrollers, and embedded systems.
  - **Bot 2 (DKB):** Community directory coordinator for mentor registrations, calendar events, and intake queries.
- **Groq AI Integration:** Multi-turn chat sessions utilizing `llama-3.3-70b-versatile` with restricted prompts focusing on technical topics.
- **PostgreSQL Session Store:** Session state is saved in Neon PostgreSQL. Supports optional JWT encryption at rest to protect authorization tokens.
- **Sequential ID Administration:**
  - Plural and singular commands to list, add, edit, disable, or enable allowed groups and private chats.
  - Administration requires sequential primary IDs rather than raw JIDs (e.g. `!rmgroup -id 4` or `!editgroup -id 2 -b 2`).
  - EPHEMERAL-safe storage: Allowlist records are saved entirely in PostgreSQL, avoiding issues with temporary local files on platforms like Render.
- **Admin Confirmation Prompts:** Deletions, edits, and bot re-assignments require a `!YES` confirmation from the specific administrator who initiated the action.
- **Background Scrapers:** Puppeteer integration fetches events and community groups from `https://dk24.org`. Uses a serialized execution queue to avoid rate limits or memory issues.
- **Security Protections:**
  - **RBAC Firewall:** Standard JIDs and `@lid` identifiers are resolved and checked against `ADMIN_JIDS` values.
  - **LID Resolver:** Resolves WhatsApp Localized Identifiers (`@lid`) to phone JIDs (`@s.whatsapp.net`) using metadata caches and socket update events.
  - **Rate Limits & Muting:** Controls message frequency per user/group and uses burst limits to prevent spam.

## Tech Stack

- **Runtime:** Node.js (v20+) with TypeScript
- **WhatsApp Client:** `@whiskeysockets/baileys` (v7.0.0-rc11)
- **Database client:** Neon PostgreSQL (using pg connection pooling)
- **AI Completion:** Groq API SDK
- **Headless Browser:** Puppeteer

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
    I -->|Bot 2 DKB| J[Puppeteer Scrapers / Mentor DB]
    I -->|Bot 0/1| K[Groq AI Completion Engine]
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

## Background Scrapers

To pull content from `https://dk24.org/calendar` and `https://dk24.org/communities`, the coordinator runs a serialized Puppeteer process:
- **Serialization Queue:** Scrape tasks are run sequentially using a queue (`serializePuppeteer`) to avoid concurrency issues and memory locks.
- **Caching:** Scrapes run in the background if cached records are older than 24 hours. The bot runs scrapers in the foreground only if the database cache table is empty.

## Render Deployment

This application is ready for deployment on Render.

1. Push your changes to your GitHub repository.
2. In Render, select **New +** -> **Blueprint**.
3. Select this repository; Render will configure services using `render.yaml`.
4. Provide the following values when prompted:
   - `GROQ_API_KEY`
   - `ADMIN_JIDS`
   - `DATABASE_URL` (Neon PostgreSQL link)
5. Keep the build and start commands as configured in `render.yaml`. The setup includes setting `PUPPETEER_CACHE_DIR` to ensure Puppeteer binaries persist correctly.

## Security Policies

1. **Firewall Filtering:** Prompts are monitored to prevent roleplay bypasses or jailbreaks.
2. **Secrets Protection:** Always use environment parameters to store connection strings and credentials.
3. **Database Audit Logs:** State changes to allowlists and mentor records are logged with the actor's JID, action type, target ID, and modifications.
