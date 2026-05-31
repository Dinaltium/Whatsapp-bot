# SELF — Admin-Only Personal Assistant

## What is SELF?

SELF is the admin-only personal assistant. It is NOT a numbered bot and is NOT in the bot registry. It uses the `!!` prefix instead of `!`.

**Access**: Only JIDs in `ADMIN_JIDS` environment variable can use SELF. Non-admins sending `!!` messages are silently ignored — no reply, no log.

## Commands

| Command | Description |
|---------|-------------|
| `!!help` | List all SELF commands |
| `!!explain <topic>` | Explain bot features using documentation files |
| `!!howdoes <thing>` | How does X work (uses docs/) |
| `!!commands <botname>` | List commands for parag/dkb/ecb |
| `!!remind <time> <message>` | Set a reminder |
| `!!reminders` | List pending reminders |
| `!!delremind <id>` | Delete a reminder by ID |
| `!!translate <lang> <text>` | Translate text (or reply to message) |
| `!!translate all <lang>` | Translate entire thread from replied message |
| `!!context` | Summarize thread from replied message |
| `!!summarize` | Same as !!context |
| `!!tldr [count]` | Summarize last N messages (default 20) |
| `!!tone` | Detect tone of replied message |
| `!!find <keyword>` | Search chat history for keyword |
| `!!voice <text>` | Generate voice message (Groq Orpheus TTS) |
| `!!reply <style>` | Draft reply (formal/casual/decline/agree) |
| `!!search <query>` | Real-time web search via Firecrawl/Tavily |
| `!!<anything>` | General question, no domain restriction |

## Time Expressions for Reminders

- `in 5 minutes` — relative time
- `in 2 hours` — relative time
- `in 1 day` — relative time
- `at 3pm` — today at 3 PM IST (or tomorrow if past)
- `tomorrow 9am` — next day 9 AM IST
- Complex expressions → AI fallback

## Voice Messages

Voice uses Groq's Orpheus TTS (`canopylabs/orpheus-arabic-saudi`):
- Gulf Arabic accent, supports mixed Arabic/English
- Daily limit: 90 messages (leaves 10 buffer before Groq's 100/day cap)
- Limit resets at midnight UTC

## Web Search

Search uses a tiered provider system:
1. **Firecrawl** (primary) — for URL extraction, website summarization, documentation analysis
2. **Tavily** (primary for general search + fallback) — current events, prices, news, general queries

Results are reranked by keyword overlap before injection into LLM context.

## Rate Limits

- 15 requests per minute (softer than regular bots since it's owner-only)
- 30 group replies per day per group (safety cap)

## Translation Support

SELF has specialized knowledge for:
- **Tulu** — Dravidian language from coastal Karnataka, often transliterated in Roman script
- **Beary** — Similar to Tulu with Arabic/Urdu loanwords
- **Malayalam** — Kerala Dravidian language

Handles non-standard spelling variants automatically.
