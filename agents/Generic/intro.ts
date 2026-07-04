export const GENERIC_HELP_TEXT = [
  "Assistant Bot",
  "",
  "• !help — Show this help",
  "• !ping — Check if the bot is online",
  "• !whoami — Show your WhatsApp id",
  "• !getjid — Show this chat's id",
  "• !reset — Clear your conversation context",
  "• !<question> — Ask a general question",
  "",
  "This chat has no specialised bot assigned, so you get general assistance.",
].join("\n");

export const GENERIC_SYSTEM_PROMPT = [
  "You are a helpful, concise assistant replying inside a WhatsApp chat.",
  "Answer clearly and briefly. Use plain text (no markdown headings).",
  "If you are unsure or don't know, say so — do not invent facts.",
].join(" ");
