# 🚀 PARAG & DKB WhatsApp Bot Coordinator

[![TypeScript](https://img.shields.io/badge/Language-TypeScript-blue.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Hosting](https://img.shields.io/badge/Deployment-Render-blueviolet.svg)](https://render.com/)
[![Database](https://img.shields.io/badge/Database-PostgreSQL_Neon-00e5a3.svg)](https://neon.tech/)

A production-grade, TypeScript-based WhatsApp bot coordinator designed for the **DK24 (Developer Kommunity 24)** and **ECB (EmbedClub)** developer ecosystems. Integrated with high-performance **Groq AI (Llama-3.3-70B)**, secure **Neon PostgreSQL** state persistence, a robust **admin RBAC firewall**, and intelligent **Puppeteer calendar scrapers**.

---

## 💎 Key Features

- **🎭 Multiple Bot Personalities (Dynamic Routing):**
  - **Bot 0 (PARAG):** Advanced technology, architecture, and hackathon assistant.
  - **Bot 1 (ECB):** Dedicated EmbedClub companion specializing in hardware, microcontrollers, and embedded systems.
  - **Bot 2 (DKB):** Official Developer Kommunity 24 companion, handling community directories, events, and mentor intake.
  - **Bot 3 (TEMP):** Sarcastic Karnataka-focused banter assistant providing Kannada/Tulu cultural translation.
- **⚡ High-Fidelity Groq AI Engine:** Multi-turn conversation sessions backed by `llama-3.3-70b-versatile` with customized system prompt restrictions (ensures the bot stays strictly on tech/hackathon topics).
- **🔒 PostgreSQL & JWT Auth Store:** Stores WhatsApp session state securely in a cloud-hosted Neon database. Includes an optional AES-JWT payload wrapper to secure session tokens at rest.
- **🛠️ Sequential ID Allowlist Administration:**
  - Plural & singular commands to list, add, edit, disable, or enable allowed groups and private chats.
  - Administration strictly uses auto-incremented database sequential IDs (e.g. `!rmgroup -id 4`, `!editgroup -id 2 -b 2`).
  - EPHEMERAL-safe storage: All allowlist administrative changes reside purely in PostgreSQL (no local JSON files that can get wiped on Vercel or Render builds).
- **🤝 Stateful Confirmation Workflows:** High-risk actions (mentor deletions, bot assignments, group removal) prompt the initiating admin for a stateful `!YES` confirmation. The session is protected by user-session isolation.
- **🕸️ Headless Puppeteer Scrapers:** Parallel-serialized web scrapers pulling live community listings and chronological event cards directly from `https://dk24.org` with dynamic delay serialization.
- **🛡️ Shielded Security Hardening:**
  - **RBAC Firewall:** Strictly matches phone JIDs and resolved `@lid` identifiers against environment admin tokens.
  - **LID Phone Resolver:** Automatically binds WhatsApp Localized Identifiers (`@lid`) to canonical phone JIDs (`@s.whatsapp.net`) dynamically using group metadata caches and native Baileys events.
  - **Rate Limiting & Muting:** Dynamic per-user rate limiting (e.g. 1 req/8s, max 5 req/60s) combined with group burst protection to prevent spam or API lockout.

---

## 🛠️ Tech Stack

- **Runtime:** Node.js (v20+) with TypeScript
- **Engine:** `@whiskeysockets/baileys` (v7.0.0-rc11) supporting final LID protocol specifications
- **Database:** Neon PostgreSQL (using pg Pool connection pooling)
- **AI Service:** Groq Cloud API
- **Web Scraper:** Puppeteer (Headless Chromium)
- **Logging:** Pino (Silent/JSON structured logging)

---

## 📋 Prerequisites

Before setting up, ensure you have the following installed on your machine:
- **Node.js** (v20.x or higher)
- **PostgreSQL** or a **Neon.tech** Cloud DB instance
- A **Groq Cloud API Key**
- A phone with WhatsApp active to link via QR code

---

## ⚙️ Environment Variables Setup

Copy `.env.example` to `.env` and configure the following variables:

```bash
cp .env.example .env
```

| Variable | Required | Description | Example |
| :--- | :--- | :--- | :--- |
| `GROQ_API_KEY` | **Yes** | Your Groq Cloud API Key | `gsk_xxxxxx...` |
| `GROQ_MODEL` | No | Llama model to invoke | `llama-3.3-70b-versatile` |
| `ADMIN_JIDS` | **Yes** | Comma-separated admin phone JIDs | `919902849280@s.whatsapp.net` |
| `ALLOWED_GROUPS` | No | Startup bootstrap group JIDs | `1203630234567@g.us 1` |
| `ALLOWED_CHATS` | No | Startup bootstrap private JIDs | `919902849280@s.whatsapp.net 2` |
| `DATABASE_URL` | **Yes** | Neon PostgreSQL connection string | `postgresql://user:pass@host/db?sslmode=require` |
| `AUTH_STATE_JWT_SECRET`| No | Encrypts auth credentials at rest in DB | `a_very_long_secure_secret_key` |
| `ALLOW_FROM_ME_MESSAGES`| No | Allow processing commands sent from self | `true` |
| `PORT` | No | Port for health check server | `3000` |

---

## 🚀 Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Run in Development Mode
Launches the bot locally with hot-reloading active:
```bash
npm run dev
```
Upon startup, the terminal will render a secure **WhatsApp QR Code**. Open WhatsApp on your mobile device -> Linked Devices -> Link a Device, and scan the QR code.

### 3. Build & Run in Production
```bash
npm run build
npm start
```

---

## 📐 Architecture & request Lifecycle

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
    I -->|Bot 0/1/3| K[Groq AI Completion Engine]
    K -->|Replies via typing state| L[WhatsApp Send Socket]
```

### Database Schema Map

The database schema is fully bootstrapped automatically upon bot startup:

```
wa_allowed_groups (Groups allowlist)
├── id (SERIAL, Primary Key)
├── jid (TEXT, Unique, Not Null)
├── bot_number (INTEGER, default 0)
├── enabled (BOOLEAN, default TRUE)
└── added_at (TIMESTAMPTZ)

wa_allowed_chats (Private chats allowlist)
├── id (SERIAL, Primary Key)
├── jid (TEXT, Unique, Not Null)
├── bot_number (INTEGER, default 0)
├── enabled (BOOLEAN, default TRUE)
└── added_at (TIMESTAMPTZ)

dk24_mentors (Mentor Directory)
├── id (SERIAL, Primary Key)
├── name (TEXT, Not Null)
├── organization (TEXT)
├── expertise (TEXT)
├── description (TEXT)
├── linkedin/instagram/github/email/phone (TEXT)
└── created_at (TIMESTAMPTZ)

dk24_action_logs (Administrative Audit Logs)
├── id (SERIAL, Primary Key)
├── actor_jid (TEXT)
├── action_type (TEXT)
├── target_id (TEXT)
├── target_name (TEXT)
├── details (TEXT)
└── logged_at (TIMESTAMPTZ)
```

---

## 🛠️ Administrative Commands Reference

Only callable by administrators listed in `ADMIN_JIDS`. Standard commands require `!` prefix.

### Allowlist & Bot Management
- `!addgroup <group_jid> [bot_number]`
  - Registers a group and designates the bot number, starting as enabled.
- `!rmgroup -id <id_number>` (or `!removegroup`)
  - Deletes a group from the allowlist by sequential database ID. Requires stateful `!YES` confirmation.
- `!listgroups` (or `!listgroup`)
  - Lists allowed groups, sequential database IDs, bot assignments, and status flags.
- `!addchat <chat_jid> [bot_number]`
  - Registers a private chat JID and designates the bot number.
- `!rmchat -id <id_number>` (or `!removechat`)
  - Deletes a private chat from the allowlist by ID. Requires stateful `!YES` confirmation.
- `!listchats` (or `!listchat`)
  - Lists allowed chats, sequential database IDs, bot assignments, and status flags.
- `!editgroup -id <id_number> -b <bot_number>` / `!editchat -id <id_number> -b <bot_number>`
  - Updates the active bot assignment. If already set to that bot, alerts and skips. Otherwise, prompts for `!YES` confirmation.
- `!disablegroup -id <id_number>` / `!disablechat -id <id_number>`
  - Instantly toggles the enabled flag to `false`. The bot immediately silences itself in the target channel (no confirmation required).
- `!enablegroup -id <id_number>` / `!enablechat -id <id_number>`
  - Instantly toggles the enabled flag to `true` (no confirmation required).

### Database Utilities
- `!neonping`
  - Validates Neon database latency and connectivity metrics.
- `!neonconnect`
  - Triggers a clean hard reconnect, allowing Render/Railway to restart the process and bind environment variables cleanly.

---

## 👥 DKB (Bot 2) Directory & Intake Commands

Designed to manage the DK24 Directory and Mentor Intake.

- `!mentors [page]`
  - Renders a paginated, alphabetical list of mentors (10 per page).
- `!mentor -id <id_number>`
  - Performs a detailed directory lookup for a single mentor by sequential database ID.
- `!mentor -f <query> [page]`
  - Filters mentors alphabetically by name, expertise, or organization.
- `!addmentor -n <name> -o <org> [-d <desc>] [-ex <expert>] [-l <linkedin>] ...`
  - Registers a new mentor in the DK24 database.
- `!editmentor -id <id_number> -<flag> <value>`
  - Updates a single field on a mentor by ID (supported flags: `-n` (name), `-o` (org), `-d` (desc), `-ex` (expertise), `-l` (linkedin), `-i` (instagram), `-g` (github), `-e` (email), `-p` (phone)).
- `!delmentor -id <id_number>`
  - Removes a mentor from the directory by ID. Requires stateful `!YES` confirmation.

---

## 🕷️ Serialized Calendar & Communities Scraper

To fetch live, dynamic content from `https://dk24.org/calendar` and `https://dk24.org/communities`, the bot orchestrates a serialized Puppeteer headless browser:
- **Serially Queued Tasks:** All scrapers pass through a serialization queue (`serializePuppeteer`) to completely prevent deadlocks or high-concurrency rate limiters.
- **Static Cache-Bypassing:** Scrapes are run in the background if the cache is older than 24 hours (serves instantly, updates quietly), or in the foreground if the database cache is completely empty.

---

## 🚀 Deployment on Render

This project is fully structured for Render deployments using the Render Web Service Blueprint.

### Step-by-Step Setup
1. Fork or push this repository to your **GitHub** account.
2. In Render: **New +** → **Blueprint**.
3. Select this repository; Render will read [render.yaml](render.yaml).
4. Configure required secrets in the dashboard:
   - `GROQ_API_KEY`
   - `ADMIN_JIDS`
   - `DATABASE_URL` (your Neon PostgreSQL connection string)
5. Set `PUPPETEER_CACHE_DIR` to `/opt/render/project/src/node_modules/.cache/puppeteer` to preserve Puppeteer caching between builds.
6. Click **Deploy**.
7. View worker logs, scan the **QR Code** on initial startup, and the bot will start coordinating WhatsApp sessions.

---

## 🔒 Security Hardening Policies

1. **Prompt Injection Firewall:** The completions engine blocks system prompt tampering or roleplay jailbreaks.
2. **Environment Isolation:** Session secrets, API keys, and database credentials must remain strictly locked inside environment parameters.
3. **Audit Trail Accountability:** All modifying administrative operations are logged to the database with the JID of the actor, action type, target ID, and JSON details.
