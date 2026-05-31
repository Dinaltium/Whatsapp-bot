# Baileys Overview — How the WhatsApp Connection Works

## What is Baileys?

Baileys is an open-source WhatsApp Web API library for Node.js ([@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys)). It implements the WhatsApp Web multi-device protocol, allowing bots to send and receive messages without requiring an always-on phone.

## QR Code Linking

When the bot starts for the first time:
1. Baileys generates a QR code displayed in the terminal
2. You scan it using WhatsApp on your phone (Linked Devices)
3. WhatsApp registers the bot as a linked device on your account
4. Session credentials are saved to Neon PostgreSQL so the QR code is only needed once

After scanning, the bot stays connected independently — your phone does not need to be online.

## Session Persistence

Auth state is stored in Neon PostgreSQL via a custom `useNeonAuthState` adapter:
- Stores Baileys signal keys, pre-keys, and session data in the database
- Survives server restarts and deployments without re-scanning QR
- If auth state is lost, the QR code flow repeats automatically

## LID Resolution

WhatsApp uses two identifier systems:
- **Phone JID** (`@s.whatsapp.net`) — the traditional phone number format
- **LID** (`@lid`) — an anonymized identifier used in multi-device contexts

In group chats, participants may appear as `@lid` instead of their phone JID. The bot resolves LIDs to phone JIDs using three strategies:
1. Database lookup (`wa_lid_phone_map` table)
2. Baileys signal repository (`sock.signalRepository?.lidMapping`)
3. Group metadata participant scan

LID resolution is required for RBAC permission checks since roles are stored against phone JIDs.

## Why Certain Limitations Exist

- **Rate limits**: WhatsApp bans accounts that send too many messages too fast. The bot enforces per-JID and global limits.
- **Announcement groups**: Bots cannot post in announcement-only groups unless they are admins. The bot detects this and stays silent to avoid 403 errors.
- **Echo detection**: The bot tracks the last message it sent to each chat. If an incoming message matches exactly, it is suppressed to prevent reply loops.
- **Anti-replay**: Messages older than 2 minutes are discarded to prevent replaying historical messages on reconnect.
- **Idempotency**: Each message gets a Redis key to prevent processing it twice (e.g., after a reconnect during processing).

## Connection States

- `connecting` → Attempting socket connection
- `open` → Connected, ready to send/receive
- `close` → Disconnected; bot auto-reconnects unless logged out

Disconnect reason codes:
- `515` → Server restart required
- `401` → Logged out (QR re-scan needed)
- `440` → Connection replaced by another session (another bot instance running)
