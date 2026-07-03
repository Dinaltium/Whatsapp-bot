# Roadmap — Audit Follow-up (2026-07-03)

Planning-only session. No code changed. This captures every decision made after the
full security/architecture/bot-design/RAG/ban-risk audit, so the next session (Opus)
has full context without re-deriving it.

Status legend: **DO FIRST** / Planned / Needs design / Deferred / Blocked-on-info

---

## 0. Do first, next session (before anything else)

- **Update `@whiskeysockets/baileys` from `7.0.0-rc11` → `7.0.0-rc13`.**
  rc11 is inside the vulnerable range of **CVE-2026-48063** (critical, CVSS 9.3) —
  message upsert / hist-sync spoofing + app-state corruption via crafted
  `protocolMessage` payload, zero privileges required. `logs.md` shows 12x
  `"Closing open session in favor of incoming prekey bundle"` in an 11-minute
  window before a crash — matches this CVE's symptom pattern. Server has been
  manually stopped since. One-line `package.json` bump + `npm install`, do this
  before restarting the bot.

---

## 1. Security

| Item | Decision | Status |
|---|---|---|
| Prompt-injection firewall (keyword-bypass flaw in `promptFirewall.ts`) | Replace with **Agent Defender** (`agent-defender` npm package, from `C:\Projects\VoidHackJune26\agent-defender-js`). It's action-level (blocks tool-calls/egress/secrets), not vocabulary-level — solves the "hackfest/hackathon" false-negative problem entirely since it never scans for topic words. Wrap the Groq client via its OpenAI-compatible adapter instead of the current custom LLM-judge call. | Planned |
| Admin escalation (`!manage`, RBAC roles) | Confirmed: hard-admin (`isAdminSender`) is env-var/`fromMe`-gated only — no in-app path grants it today. Verify separately that `role.manage` holders can't mint a new role carrying `role.manage` itself and hand it to others (peer-manager escalation) — lock this down if confirmed possible. | Needs verification |
| `logs.md` session-churn issue | Root cause is the CVE above, not infra. Resolved by the version bump. | Resolved by §0 |
| Rate limiter (Redis key collision risk) | Queued, no change in approach yet. | Planned |
| Intro detector (auto-classify mentor/student on group add) | **Scrapped in favor of cross-group notify design.** See §6 below. | Redesigned |

## 2. Architecture

| Item | Decision | Status |
|---|---|---|
| BullMQ (unused queue infra) | **Remove.** Confirmed scale (4-5 groups, rate-limited) never approaches the throughput BullMQ exists to solve — it's dead weight, not future-proofing. | Planned |
| Dual session storage (in-memory Map in `bot.ts` + Redis in `core/state.ts`) | **Remove the in-memory Map.** Confirmed dead — nothing in the live message path reads it. Redis-only going forward. | Planned |
| Per-message error isolation in `messageRouter.ts` for-loop | Wrap each message's full processing body in its own try/catch (currently only the AI-call section is guarded). One throwing message currently drops every subsequent message in that batch — silent loss, no retry. **Confirmed priority: work on ASAP.** | Planned — high priority |
| Reconnect logic gaps | Directly related to the CVE/logs.md issue — resolved by §0 bump; revisit disconnect-code coverage after confirming stability. | Tied to §0 |
| Scale ceiling | Confirmed: hard cap at 4-5 groups, no plan to expand. Rate limits + allowlist stay as the containment mechanism ("the leash"). | Confirmed, no architecture change needed |

## 3. Bot / agent design

| Item | Decision | Status |
|---|---|---|
| Generic-bot restructure | Confirmed target shape:<br>`WhatsAppAgent → Generic (default, no persona name) → {PARAG, ECB, DKB}`<br>`WhatsAppAgent → SELF (direct, bypasses registry — already true today)`<br>Bot-number plan: **`0` → Generic**, PARAG gets a new number. | Planned |
| DB migration for bot-number reassignment | **Needed.** Any group/chat currently defaulting to `botNumber = 0` (today = PARAG) must be explicitly re-mapped to PARAG's new number *before* deploying the Generic-bot change, or those groups silently become Generic instead of PARAG. One-time migration script. | Planned — must run before deploy |
| Dynamic/shared bot registry + extracted `BotHandler` base class | Confirmed direction: turn `agents/core/BotHandler.ts` into a real shared base (session handling, domain-lock, error-wrapping, command-parsing) instead of just an interface; each persona subclasses only what differs (intro text, domain keywords, persona-specific commands). Goal: new persona = ~30 lines instead of ~100 copy-pasted. | Planned |
| Handler-level resilience | Recommendation: wrap each persona's command dispatch (mentor/club/event handling, etc.) in its own try/catch → log + graceful fallback string, instead of letting one broken subcommand kill the whole handler for that turn. Keep the existing top-level `WhatsAppAgent` catch as last-resort net. | Confirmed, planned |
| Mentor list pagination + data validation | 10-20 mentors per page, alphabetical, existing `filter`/`next` to page further. Add format validation on LinkedIn/GitHub/Instagram/email fields at submission time. | Planned |

## 4. RAG / search

| Item | Decision | Status |
|---|---|---|
| What this actually is | Not a vector-DB RAG — it's live-web-search-augmented generation ("web RAG"), which is correct for the stated goal (fresh news/scores/live events would go stale in a static vector store anyway). Naming is fine as-is. | Clarified, no change |
| Source-trust reranking, citations, cross-source agreement check | **Build these.** Replace keyword-overlap reranking with actual trust/quality signals (domain reputation, recency, source type); surface citations; flag when sources disagree instead of picking one silently. | Planned |
| Image search results | Explicitly **deferred** — user wants to plan separately how it fits (see §7, `-i` flag). Do not build until that design lands. | Deferred |
| Redis caching of search results | **Build.** Biggest single ROI on latency + API cost — currently zero caching exists. | Planned |
| Query-classification-before-search (check cache/DB before live search) | **Build.** Currently always fires a live search even for community-data questions Postgres could answer directly. | Planned |
| RAG scope | Confirmed: **SELF = universal web search. DKB + PARAG = shared scoped tech/community RAG** (not DKB-only as originally suggested). **ECB = none.** | Confirmed |
| `GROQ_MODEL_SCOUT` fallback wiring | Wire it up as a genuine fallback, used **only** when the primary model errors/rate-limits — kept rare/emergency-only, not a load-balancing path. | Planned |

## 5. Baileys / ban-risk

| Item | Decision | Status |
|---|---|---|
| Version bump to rc13 | See §0 — do first. | DO FIRST |
| Typing delay cap (currently flat 20-30s regardless of response length) | Fix so length keeps influencing delay further out (diminishing-returns curve, sane ceiling e.g. 45-60s) instead of hard-chopping long AI responses to the same cap as short ones. | Planned |
| Outgoing rate guard (per-JID only, no global cap) | Add a global per-minute send cap across all recipients combined, in addition to the existing per-JID 5/min limit. Confirmed priority: user explicitly OK with slower replies if it keeps the account looking non-spammy — favor safety over speed. | Planned |
| Content variation / dedup on identical replies | Plan only, no build yet. | Deferred |

## 6. Intro-detector redesign (replaces LLM auto-classification)

Problem with the original design: classification from a buffered set of freeform
messages is unpredictable (people describe themselves inconsistently — "works at
X" then later "actually I'm a student"), and misclassification creates cleanup
burden. Missing additions entirely was the other complaint with doing this fully
manually.

**New design (bot deployed across 2 groups already — reuse that):**

1. Bot listens for the actual `group-participants.update` (action: add) event in
   the main group — not text-pattern guessing.
2. On a new add, bot posts a notification in the **second group**, where every
   mentor-role holder already lives: "New member added: `<name/number>`. Reply
   to confirm mentor or skip."
3. A mentor-role holder (or the owner) responds using the **existing
   `!addmentor -n <name> -o <org> ... -p <phone>` command directly**, with the
   detected phone number already written into the notification text so it can
   be copy-adjusted rather than typed from scratch. No new command name
   introduced — reuses what already exists, rather than any new classification
   or confirm-command logic.
4. No response within a set window (e.g. 24-48h) → entry just expires, no
   default action taken, optionally one gentle reminder ping.

No LLM judgment call anywhere in this flow — fixes "easy to miss" (event-driven,
can't forget) without reintroducing "unpredictable classification" (a human
mentor makes the actual call, in one command).

## 7. New feature ideas (parked for future planning, not yet scoped for build)

**Image-request flag (SELF bot, `!!` prefix) — flag letter needs to change:**
Originally proposed as `-i`. **Conflict found:** `-i` already means Instagram in
`!addmentor`/`!editmentor` (`agents/DKB/commands/mentorCommands.ts:365,340,482`).
Different bot and different prefix (`!` structured-flag command vs `!!`
freeform-query trailing marker), so there's no actual runtime collision — but
reusing `-i` for a completely different meaning elsewhere in the same overall
bot is exactly the kind of mnemonic clash worth avoiding. **Use `-img` instead**
(or similar unambiguous token) for the image-request marker.

Syntax otherwise confirmed: trailing ` -img` on the message requests an image
be attached to the reply; a literal hyphen needed inside the question itself is
escaped by wrapping it in quotes (`"-"`), unescaped after flag-parsing. Example:
`!!Who is the fastest runner in the world "-" in which country -img` →
image requested, question becomes `Who is the fastest runner in the world - in
which country`. Rationale: keeps images opt-in and rare instead of auto-attaching
on every answer (avoids chat clutter + filling recipients' galleries). Parser
design is settled and cheap; the actual image-sourcing step is still blocked on
the deferred RAG image-search planning above (§4) — decided to source from
recently-uploaded chat/group images rather than a live image-search API.

**Voice-note replies via Groq TTS:**
Clarified scope: a real WhatsApp *call* (VoIP) is not realistically buildable on
Baileys and pursuing it would be a meaningful ban-risk regression, inconsistent
with the "slower replies are fine, don't want to look like spam" stance taken
elsewhere in this plan. The buildable version of this idea: bot sends a **voice
note** (Groq TTS → audio message via Baileys, same mechanism as sending an
image) instead of / alongside text.

**Correction after checking the codebase: `!!voice` already exists.**
`agents/SELF/handler.ts:489-531` already implements `!!voice <text>` (or reply
to a quoted message) — generates TTS via `generateVoiceMessage()`
(`utils/voiceMessage.ts`) and sends it as a WhatsApp voice note (`ptt: true`)
to `from`, i.e. **whatever chat the command was typed in**. It already has its
own daily rate limit (`SELF_RATE_LIMIT.voiceDailyLimit`) — that's already the
"double leash" this feature needs; nothing new required there.

So the actual scope is small: **extend the existing `!!voice` handler with an
optional `-id <n>` argument that overrides the send destination** away from
`from` to a resolved JID, instead of building a new command from scratch.
`-id n` resolves via the existing `chatConfig.getChatEntryById(n)`
(`config/chatAllowlist.ts`) — the same id space `!listchats` already displays,
so no new registry/`-add`/`-list` subcommands needed.

Usage becomes: `!!voice <text>` unchanged (speaks in the current chat);
`!!voice -id <n> <text>` sends to chat-allowlist entry `n` instead. Distinctive
non-user TTS voice (already set up, Arabic-accented) stays as-is so the
recipient can tell it's the bot, not an impersonation of the user.

Needs before build:
- Decide whether the first-ever message to a given trusted id needs any
  one-time "this is the bot" framing, or whether the distinctive voice alone
  is sufficient (open question, not a blocker).
- Confirm the daily voice rate limit should apply globally across all `-id`
  destinations combined, not reset per-destination (otherwise the limit could
  be trivially multiplied by spreading messages across many `-id` targets).

Explicitly out of scope, permanently: any version of this aimed at
non-consenting/unknown recipients, or using a voice/identity meant to convince
someone it's a real specific person rather than the bot. Scope is locked to
trusted contacts + recognizably-bot voice + joke/casual content only.

---

## Suggested execution order for next session

1. Baileys version bump (§0) — trivial, do it before restarting the bot at all.
2. Per-message try/catch in `messageRouter.ts` (§2) — cheap, high value, no
   design dependencies.
3. Remove dead in-memory session Map + BullMQ (§2) — cheap cleanup, no
   dependencies.
4. Intro-detector redesign (§6) — event-driven, no LLM dependency, self-contained.
5. Agent Defender integration (§1) — replaces `promptFirewall.ts` wholesale.
6. Generic-bot restructure + DB migration (§3) — do the migration *before*
   deploying the code change.
7. Shared `BotHandler` base class extraction (§3).
8. RAG: caching → query classification → source-trust reranking (§4), in that
   order (each layer makes the next one more useful).
9. Mentor pagination/validation, typing-delay curve, global outgoing cap —
   independent, can slot in anywhere.
10. `-i` flag parser + voice-note feature — once image-sourcing plan (deferred)
    is actually fleshed out.
