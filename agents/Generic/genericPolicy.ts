/**
 * Pure decision logic for the generic auto-responder (PATCHES Fix #1 + #2).
 * No I/O — trivially testable. autoResponder.ts wires Redis/WhatsApp around it.
 *
 * Fix #2: invocation is `!chat <text>` (not `!<message>`); the bot stays fully
 * silent whenever the owner is online (only steps in while away).
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
  isAllowlisted: boolean;
  isSaved: boolean;
  /** Trimmed message text. */
  text: string;
  count: number;
  limit: number;
  ownerOnline: boolean;
}

export function decideGenericAction(i: GenericPolicyInput): GenericAction {
  // Scope: only unconfigured 1:1 DMs from in-audience, non-owner senders.
  if (i.isGroup || i.isBroadcast) return { type: "pass" };
  if (i.isAdmin) return { type: "pass" };
  if (i.isAllowlisted) return { type: "pass" };
  if (!i.text) return { type: "pass" };
  if (i.text.startsWith("!!")) return { type: "pass" }; // reserved for admin/self
  if (!i.isSaved) return { type: "pass" };

  if (i.text.startsWith("!")) {
    const first = i.text.slice(1).trim().toLowerCase().split(/\s+/)[0];
    // Utility commands: always allowed, never counted (even while online).
    if (first === "reset") return { type: "reset" };
    if (first === "help") return { type: "help" };
    if (first === "chat") {
      const userMsg = i.text.slice(1).trim().replace(/^chat\b/i, "").trim();
      if (!userMsg) return { type: "help" }; // "!chat" alone → show usage
      if (i.ownerOnline) return { type: "silent" }; // owner active → don't step in
      if (i.count >= i.limit) return { type: "silent" }; // budget spent
      return { type: "reply", userMsg };
    }
    // Any other `!something` (e.g. the classic "!<message>" fumble) falls
    // through and is treated like a normal message → greeting logic below.
  }

  // Non-command message: one offline greeting for the first message only.
  if (i.ownerOnline) return { type: "silent" }; // owner active → don't step in
  if (i.count >= i.limit) return { type: "silent" }; // budget spent → go quiet
  if (i.count > 0) return { type: "silent" }; // greeting already used
  return { type: "greet" }; // first message while away → offline greeting
}
