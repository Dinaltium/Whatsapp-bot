/**
 * Pure decision logic for the generic auto-responder (PATCHES Fix #1 + #2).
 * No I/O — trivially testable. autoResponder.ts wires Redis/WhatsApp around it.
 *
 * Fix #2: invocation is `!chat <text>`; the bot is silent while the owner is
 * online. Bot 0 is also available INSIDE bot-1/2/3 chats — there it only owns
 * `!chat` and plain messages (greeting/notify); every other command belongs to
 * the assigned bot (the caller passes those straight through as "pass").
 */
export type GenericAction =
  | { type: "pass" } // not ours — let the normal command flow run
  | { type: "reset" } // clear context (never counted)
  | { type: "help" } // show generic help (never counted)
  | { type: "reply"; userMsg: string } // counted assistant reply (via !chat)
  | { type: "greet" } // counted offline greeting
  | { type: "silent" }; // handled, no reply (owner online / over budget / spent)

export interface GenericPolicyInput {
  isGroup: boolean;
  isBroadcast: boolean;
  isAdmin: boolean;
  /** True when the chat has a bot assigned (in the allowlist). */
  isAllowlisted: boolean;
  isSaved: boolean;
  /** Trimmed message text. */
  text: string;
  count: number;
  limit: number;
  ownerOnline: boolean;
}

export function decideGenericAction(i: GenericPolicyInput): GenericAction {
  if (i.isGroup || i.isBroadcast) return { type: "pass" };
  if (i.isAdmin) return { type: "pass" };
  if (!i.text) return { type: "pass" };
  if (i.text.startsWith("!!")) return { type: "pass" }; // reserved for admin/self
  if (!i.isSaved) return { type: "pass" };

  if (i.text.startsWith("!")) {
    const first = i.text.slice(1).trim().toLowerCase().split(/\s+/)[0];
    if (first === "chat") {
      const userMsg = i.text.slice(1).trim().replace(/^chat\b/i, "").trim();
      if (!userMsg) return { type: "help" }; // "!chat" alone → usage
      if (i.ownerOnline) return { type: "silent" }; // owner active → don't step in
      if (i.count >= i.limit) return { type: "silent" }; // budget spent
      return { type: "reply", userMsg };
    }
    // In a bot-1/2/3 chat every other command belongs to the assigned bot.
    if (i.isAllowlisted) return { type: "pass" };
    // Personal-DM utility commands (generic-owned):
    if (first === "reset") return { type: "reset" };
    if (first === "help") return { type: "help" };
    // Unknown "!..." (e.g. the classic "!<message>" fumble) → greeting logic.
  }

  // Non-command message: one offline greeting for the first message only.
  if (i.ownerOnline) return { type: "silent" }; // owner active → don't step in
  if (i.count >= i.limit) return { type: "silent" }; // budget spent → go quiet
  if (i.count > 0) return { type: "silent" }; // greeting already used
  return { type: "greet" }; // first message while away → offline greeting
}
