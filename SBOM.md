# 📦 Software Bill of Materials (SBOM)

This document contains a comprehensive breakdown of all software dependencies, licensing terms, and purposes for the **PARAG & DKB WhatsApp Bot Coordinator**.

- **Format:** SPDX / CycloneDX JSON Compatible
- **Generated At:** 2026-05-24T09:15:00Z
- **JSON Payload Reference:** [sbom-cyclonedx.json](file:///c:/Projects/Whatsapp-bot/sbom-cyclonedx.json)

---

## 💎 Primary Application Metadata

- **Component Name:** `parag-whatsapp-bot`
- **Version:** `1.0.0`
- **Application License:** `MIT`
- **Repository Visibility:** Private

---

## 📦 Runtime Dependencies

These libraries are required for the execution of the bot in development and production environments.

| Name | Version | License | Purpose / Description |
| :--- | :--- | :--- | :--- |
| **`@whiskeysockets/baileys`** | `^7.0.0-rc11` | MIT | WhatsApp Web socket engine supporting Baileys LID architecture. |
| **`dotenv`** | `^17.4.2` | BSD-2-Clause | Safe environment variables injector from `.env` file. |
| **`groq-sdk`** | `^0.5.0` | MIT | Developer SDK for Groq Cloud completions engines. |
| **`jsonwebtoken`** | `^9.0.2` | MIT | Secure JWT packaging for auth payloads stored in Neon DB. |
| **`pg`** | `^8.16.3` | MIT | PostgreSQL client and connection pooling wrapper. |
| **`pino`** | `^10.3.1` | MIT | High-performance, low-overhead structured event logger. |
| **`puppeteer`** | `^24.43.1` | Apache-2.0 | Headless Chromium engine for calendar and communities scraping. |
| **`qrcode-terminal`** | `^0.12.0` | Apache-2.0 | Standard terminal scan-QR generator on startup. |

---

## 🛠️ Development Dependencies

These utilities are required purely for building, type-checking, and transpiling the application during CI/CD and deployment pipelines.

| Name | Version | License | Purpose / Description |
| :--- | :--- | :--- | :--- |
| **`typescript`** | `^5.3.3` | Apache-2.0 | Safe, strongly typed code transpiler to target JavaScript. |
| **`nodemon`** | `^3.1.14` | MIT | Hot-reloading watcher for local development cycles. |
| **`tsx`** | `^4.7.0` | MIT | Direct TS execution layer for scripting test environments. |
| **`@types/node`** | `^20.19.41` | MIT | Node.js typings definitions. |
| **`@types/pg`** | `^8.20.0` | MIT | PostgreSQL client typescript definitions. |
| **`@types/jsonwebtoken`** | `^9.0.10` | MIT | JWT encryption wrapper definitions. |
| **`@types/qrcode-terminal`** | `^0.12.2` | MIT | QRCode terminal generator definitions. |

---

## 🛡️ Security & Compliance Hardening

1. **Licensing Compliance:** No copyleft (e.g. GPL/AGPL) licenses are used inside runtime dependencies, ensuring high structural safety.
2. **PostgreSQL Security:** `pg` connectivity employs active SSL enforcement when interfacing with the Neon Cloud database.
3. **EPHEMERAL Integrity:** Local JSON writes are completely omitted; all allowed group/chat lists and toggle states persist securely in the database schema.
