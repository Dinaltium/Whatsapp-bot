# System Architecture

## Overview

```
WhatsApp Socket (one connection)
        ↓
   [HEAD BOT - messageRouter.ts]
   - Reads prefix (!! or !)
   - Anti-replay, idempotency, LID resolution
   - Global user rate limit check
   - Contact name caching
        ↓                              ↓
   !! detected                    ! detected
   isAdmin check                  Allowlist check
        ↓                              ↓
   [ADMIN BOT]               Bot number lookup
   agents/SELF/              ┌─────┬─────┬─────┐
   handler.ts               [B0]  [B1]  [B2]
                            PARAG  ECB   DKB
```

## Head Bot (messageRouter.ts)

The head bot is the single entry point for all incoming messages. It:

1. **Anti-replay guards** — Discards messages older than 2 minutes; uses Redis idempotency keys to prevent double-processing
2. **LID resolution** — Resolves `@lid` senders to `@s.whatsapp.net` phone JIDs via DB, Baileys signal repository, or group metadata scan
3. **Contact name caching** — Stores push names in Redis hash `contact_names` for context window use
4. **SELF intercept** — If message starts with `!!`, checks admin status; routes to SELF handler or silently ignores
5. **Allowlist check** — For `!` commands, verifies group/chat is in the allowlist
6. **Bot number lookup** — Groups and chats have an assigned bot number (0, 1, or 2)
7. **Command dispatch** — Routes to registered commands or the appropriate bot agent

## Bot Registry (WhatsAppAgent.ts)

The bot registry holds three BotHandler objects:
- `0` → PARAG (tech/hackathon)
- `1` → ECB (EmbedClub hardware)
- `2` → DKB (DK24 community)

SELF is **never** in this registry.

## Session Management

Sessions are stored in Redis with a 15-minute TTL:
- Key: `session:{from}:{senderId}`
- Contains: conversation messages, pending multi-turn state, domain unlock flag
- Shared between messageRouter and command handlers via `core/state.ts`

## Rate Limiting (security/rateLimiter.ts)

Multiple tiers of rate limiting:
1. **Global user hourly limit** — 20 commands/hour across all bots (Redis: `global_rate:{senderId}:{hourBucket}`)
2. **Per-user AI limit** — 5 AI requests/minute per user per chat (Redis: `rate_limit:{from}:{senderId}`)
3. **Per-group hourly limit** — 100 AI responses/hour per group
4. **Global daily AI limit** — 2000 AI responses/day total
5. **Outgoing rate guard** — Max 5 messages/minute to any single JID
6. **Burst detection** — 4+ messages in 10 seconds triggers a 10-minute group mute

Admins are exempt from global user hourly limit. SELF has its own softer limit (15/minute).

## RBAC System (security/rbac.ts + storage/core/rbacRepository.ts)

Roles are stored in `rbac_roles` and `rbac_user_roles` tables. The old `dk24_managed_roles` table is migrated into this system.

Role check flow:
1. Parse command name
2. Check if command requires admin or a specific role
3. If `requiresAdmin`: verify sender is in `ADMIN_JIDS`
4. If `requiresRole`: check `rbac_user_roles` for the sender's JID

LID senders are resolved before role checks since roles are indexed by phone JID.

## Infrastructure

- **Reminder scheduler** — Polls `self_reminders` every 60 seconds, sends due reminders
- **Health server** — HTTP endpoint on `PORT` (default 3000) for hosting platform health checks
- **Redis** — Session storage, rate limiting, contact names, chat history, idempotency keys
- **Neon PostgreSQL** — Auth state, allowlists, roles, mentors, events, clubs, ECB data, reminders
