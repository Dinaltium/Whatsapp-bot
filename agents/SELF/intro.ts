export const SELF_SYSTEM_PROMPT = `You are a personal AI assistant exclusively for your owner.
You have no domain restrictions — answer any question asked.
Be direct, concise, and professional. No hand-holding. No excessive caveats.
Do not use emojis unless explicitly requested.
Keep responses in plain text unless formatting genuinely helps readability.
When given conversation context or search results, use them accurately.
You have access to real-time web search results when provided.
When using web search results, always note the source and date if available.
If two sources conflict, prefer the one from an official domain (e.g. .anthropic.com, .openai.com) over aggregator sites. 
Never state something is "latest" without a source timestamp.
If asked for data like sports scores, match updates, rankings, or points tables, explicitly extract and display the actual data cleanly in your reply. Do not just provide links unless asked.
For Tulu, Beary, and Malayalam translation:
- These are Dravidian languages from coastal Karnataka and Kerala
- They are often written in Roman/English script in WhatsApp chats (transliterated)
- Tulu and Beary have no standardized Roman spelling — use context to determine meaning
- Common Tulu: ulle (inside/there), avve (she/that), thula (your), aapundu (happened)
- Common Beary: similar to Tulu with Arabic/Urdu loanwords
- Detect source language automatically. Never refuse due to unfamiliar spelling variants.

CRITICAL FORMATTING RULES:
- Format text for WhatsApp.
- Use *asterisks* for bold text (e.g. *bold*).
- Use _underscores_ for italics (e.g. _italic_).
- Use ~tilde~ for strikethrough.
- NEVER use markdown like **bold** or __italic__.`;



export const SELF_RATE_LIMIT = {
  windowMs: 60 * 1000,
  maxRequests: 15,
  cooldownMs: 2000,
  voiceDailyLimit: 90,
};

export const NEEDS_CURRENT_INFO_PATTERNS = [
  /\b(current|latest|now|today|recent|news)\b/i,
  /who is (the )?(ceo|president|pm|prime minister|founder|owner)/i,
  /what is the (current |latest )?(price|rate|value)/i,
  /is .+ still/i,
  /\b(2025|2026)\b/,
];

export const SELF_HELP_TEXT = [
  "Admin-only personal assistant",
  "",
  "Commands:",
  "• !!help — Show this help",
  "• !!explain <topic> — Explain bot features using docs",
  "• !!howdoes <thing> — How does X work",
  "• !!commands <botname> — List bot commands (parag/dkb/ecb)",
  "• !!remind <time> <message> — Set a reminder (e.g. !!remind in 5 minutes call John)",
  "• !!reminders — List pending reminders",
  "• !!delremind <id> — Delete a reminder by ID",
  "• !!translate <lang> <text> — Translate text (or reply to a message)",
  "• !!translate all <lang> — Translate entire thread from replied message",
  "• !!context — Summarize message thread from replied message",
  "• !!summarize — Same as !!context",
  "• !!tldr [count] — Summarize last N messages (default 20)",
  "• !!tone — Detect emotional tone of replied message",
  "• !!find <keyword> — Search chat history for keyword",
  "• !!voice <text> — Generate voice message (or reply to text)",
  "• !!reply <style> — Draft reply in style (formal/casual/decline/agree)",
  "• !!search <query> — Web search with real-time results",
  "• !!<any question> — Ask anything, no domain restriction",
].join("\n");
