# PARAG Bot Coordinator Command Manual

This document details every single built-in command available in the PARAG WhatsApp Bot Coordinator system, including their purposes, permission levels, arguments, and execution flows.

---

## Command Categories
- [1. Core Utility Commands](#1-core-utility-commands) (Available to all users)
- [2. Administrative & Configuration Commands](#2-administrative--configuration-commands) (Admin Only)
- [3. Majestic Decryption Commands](#3-majestic-decryption-commands) (Admin Only, custom triggers)
- [4. Community Directory Commands](#4-community-directory-commands) (Bot 2 - DKB Only)
- [5. Role-Based Access Control (RBAC) Commands](#5-role-based-access-control-rbac-commands) (Bot 2 - DKB Only)

---

## 1. Core Utility Commands
These commands are lightweight utility functions accessible by **any user** in any approved chat or group.

### `!help`
* **Purpose:** Displays a dynamically tailored help manual listing all available commands for the active bot profile in the current chat.
* **Outputs:** 
  * If the chat is using **Bot 0 (PARAG)**: Returns the technology and general-purpose chat command set.
  * If the chat is using **Bot 1 (ECB)**: Returns the hardware and embedded club help menu.
  * If the chat is using **Bot 2 (DKB)**: Returns the extensive developer community event, directory, and mentor listing help menu.

### `!ping`
* **Purpose:** Heartbeat check to verify if the bot engine is alive, online, and responding.
* **Response:** `pong`

### `!hello`
* **Purpose:** Verification command confirming the bot's system coordinator status.
* **Response:** `PARAG online and operational.`

### `!reset`
* **Purpose:** Clears the active conversation thread history and token memory with the AI engine for the sender in the current chat.
* **Response:** `Context reset for your session. Start with a new !tech or !hackathon question.`

### `!getjid`
* **Purpose:** Helper tool that returns the exact WhatsApp JID of the current chat.
* **Response:** `Group JID: <jid>@g.us` or `Chat JID: <jid>@s.whatsapp.net`

### `!whoami`
* **Purpose:** Returns the sender JID, Phone JID, or alternate Baileys LID JID, along with its normalized format.
* **Response:** `Your JID: <raw_jid>\nNormalized: <normalized_jid>`

---

## 2. Administrative & Configuration Commands
These administrative utilities require **Global Administrator status** (`ADMIN_JIDS`). They are used to control allowlists, configure bot instances, monitor system health, and bypass all allowlist barriers.

### `!listgroups`
* **Purpose:** Lists all allowlisted WhatsApp groups configured in the database, including their database ID, group title, active bot number (0, 1, or 2), and enabled/disabled status.

### `!listchats`
* **Purpose:** Lists all allowlisted private DMs configured in the database, including their database ID, phone number JID, assigned bot profile, and enabled/disabled status.

### `!addgroup <group-jid> [bot-number]`
* **Purpose:** Appends a new WhatsApp group to the allowlist, allowing the bot to receive and respond to messages there.
* **Arguments:** 
  * `<group-jid>`: The unique group user ID ending in `@g.us`.
  * `[bot-number]`: (Optional) The bot profile integer to assign (`0` for PARAG, `1` for ECB, `2` for DKB). Defaults to `0`.

### `!addchat <chat-jid> [bot-number]`
* **Purpose:** Appends a new private DM chat to the allowlist.
* **Arguments:** 
  * `<chat-jid>`: The target phone JID (e.g. `919902849280@s.whatsapp.net` or LID JID).
  * `[bot-number]`: (Optional) Bot profile integer to assign. Defaults to `0`.

### `!rmgroup -id <id>`
* **Purpose:** Removes a group JID from the database allowlist, immediately stopping bot interactions in that group.
* **Safety Gate:** Enters an interactive confirmation prompt. The admin must type `!YES` within the session window to finalize removal.

### `!rmchat -id <id>`
* **Purpose:** Removes a private chat JID from the database allowlist.
* **Safety Gate:** Enters an interactive confirmation prompt. The admin must type `!YES` to finalize removal.

### `!editgroup -id <id> -b <bot_number>`
* **Purpose:** Changes the active bot profile personality assigned to an allowlisted group.
* **Safety Gate:** Enters an interactive confirmation prompt requesting a `!YES` confirmation.

### `!editchat -id <id> -b <bot_number>`
* **Purpose:** Changes the active bot profile personality assigned to an allowlisted private DM.
* **Safety Gate:** Enters an interactive confirmation prompt requesting a `!YES` confirmation.

### `!disablegroup -id <id>`
* **Purpose:** Temporarily disables group responses without deleting the group entry from the allowlist.

### `!disablechat -id <id>`
* **Purpose:** Temporarily disables private chat responses without deleting the chat entry from the allowlist.

### `!enablegroup -id <id>`
* **Purpose:** Re-enables responses in a temporarily disabled allowlisted group.

### `!enablechat -id <id>`
* **Purpose:** Re-enables responses in a temporarily disabled allowlisted private chat.

### `!findgroups`
* **Purpose:** Fetches all WhatsApp groups that the bot coordinator is currently a participant of, sorted by the most recent bot interaction timestamp (top 30 displayed). Handy for finding groups the bot is in but aren't allowlisted yet.

### `!findchats` (Alias: `!findchat`)
* **Purpose:** Searches through the passively cached WhatsApp contact list in Redis to find users matching a name or JID query (top 30 displayed). This resolves the issue of needing JIDs/LIDs for `!addchat` by letting you look up anyone who has previously interacted with the bot by their profile name!
* **Arguments:** 
  * `<name-or-jid-keyword>`: The search string (e.g. `!findchats Parag`).

### `!neonping`
* **Purpose:** Performs an active end-to-end ping to the Neon serverless PostgreSQL database to verify connection health and report roundtrip database query latency in milliseconds.

### `!neonconnect`
* **Purpose:** Triggers a clean hard exit (`process.exit(1)`) on the current container instance. The hosting environment manager (e.g. Dokploy/Render) will instantly start a fresh container instance to re-establish a healthy Neon connection pool.

---

## 3. Majestic Decryption Commands
These commands are used to decrypt and reveal WhatsApp **"View Once" media** (photos, videos, audio, and documents) in direct chats or groups. These utilities bypass the standard command rules and require **Global Administrator status** to run.

### Private Silent Reveal (`!reveal` / `!Reveal` / `!REVEAL`)
* **Trigger:** Prefixed with `!` and has no exclamation suffix at the end (e.g. `!reveal`). Must quote a view-once message, or will default to the latest received view-once media in the current chat.
* **Action:** Decrypts the media and sends it directly to your **private DM**.
* **Behavior:** **Absolute silence.** The bot will not print any confirmation or text messages in the group or in your DM—it silently delivers the raw media directly.

### Public Silent Reveal (`REVEAL!` / `REVEAL!!!!` / `REVEALTHIS!`)
* **Trigger:** **No prefix required.** Type exactly `REVEAL` or `REVEALTHIS` followed by any number of exclamation marks (e.g. `REVEAL!`, `REVEAL!!!!!!!!`, `REVEALTHIS!!!!!!`).
* **Action:** Decrypts the view-once media and **sends it directly inside the same active chat (group/DM)** where you sent the command.
* **Behavior:** Just returns the raw media in the chat with **zero captions, text, or commentary** showing.

### Public Majestic Blast (`THEPOWEROFWHATSAPPINMYHANDS!`)
* **Trigger:** **No prefix required.** Type exactly `THEPOWEROFWHATSAPPINMYHANDS` followed by any number of exclamation marks (e.g. `THEPOWEROFWHATSAPPINMYHANDS!!!!!!!!!!!!!!`).
* **Action:** Decrypts the view-once media and sends it directly in the same active chat.
* **Behavior:** Attaches the boisterous caption **`SHAZAAAAAM!!!`** directly on the returned image/video.

---

## 4. Community Directory Commands
These directory and catalog tools are only active for chats using **Bot 2 (DKB - Developer Kommunity 24)**. They query local caches and Neon PostgreSQL databases. When the database is empty, they dynamically trigger a foreground crawl to dk24.org using headless Puppeteer to seamlessly sync records.

### `!clubs`
* **Purpose:** Lists all official member community clubs connected to the DK24 network, including their colleges.

### `!club <name-or-college>`
* **Purpose:** Fetches full spotlight details for a community club, including description, website links, Points of Contact (POCs), and Representatives.

### `!events [month-year]`
* **Purpose:** Returns a chronological events catalog (e.g. `!events apr-2026`). If no month-year is provided, it defaults to the current active calendar month.

### `!event <event-name>`
* **Purpose:** Retrieves complete timeline, hosting community, venue, description, prize pools, tracks, and active registration links for an event.

### `!mentors [page]`
* **Purpose:** Lists registered community mentors in the directory in alphabetical order (displays 10 records per page).

### `!mentor -id <id>`
* **Purpose:** Displays the full biography, organization, LinkedIn profile, email, phone, and technical expertise tags of a mentor.

### `!mentor -f <query_or_tags> [page]`
* **Purpose:** Filters the mentor directory by matching keywords or expertise tags (e.g., `!mentor -f React`).

### `!next`
* **Purpose:** Navigates directly to the next page of results for your active mentor lookup query.

### `!page <number>`
* **Purpose:** Jumps directly to a specific page number of results for your active mentor lookup query.

### `!addmentor -n <name> -o <org> [-d <desc>] [-ex <expertise>] [-l <linkedin>] [-i <instagram>] [-g <github>] [-e <email>] [-p <phone>]`
* **Purpose:** Inserts a new mentor into the directory. Requires Admin privileges or an authorized coordinator role.

### `!editmentor -id <id> -<flag> <value>`
* **Purpose:** Modifies a single field on an existing mentor by their directory ID. Requires Admin privileges or an authorized coordinator role.

### `!delmentor -id <id>`
* **Purpose:** Removes a mentor from the directory. Requires Admin privileges or an authorized coordinator role.

---

## 5. Role-Based Access Control (RBAC) Commands
These commands manage custom community roles and granular permissions inside the WhatsApp agent system. Only active for **Bot 2 (DKB)**.

### `!manage <role> <+phone_number>`
* **Purpose:** Assigns a custom coordinator/manager role (e.g. `organizer`, `mentor`) to a WhatsApp user.
* **Permissions:** Admin privileges or users with the `role.manage` permission.

### `!manage <role> -l`
* **Purpose:** Lists all WhatsApp users currently assigned to a specific role.

### `!manage <+phone_number> -p`
* **Purpose:** Sends a private message to a specific user JID notifying them of all their currently active security roles inside the bot.

### `!role <role_name>` (Alias: `!createrole`)
* **Purpose:** Launches an interactive step-by-step role creation dialog tree. The bot will guide the authorized user through inputting a new role name, assigning custom permission nodes, and saving it to the database role registry.
