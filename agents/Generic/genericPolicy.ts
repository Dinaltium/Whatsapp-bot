/**
 * Pure decision logic for the generic auto-responder (PATCHES Fix #1).
 * No I/O — trivially testable. autoResponder.ts wires Redis/WhatsApp around it.
 */
export type GenericAction =
  | { type: "pass" } // not ours — let the normal command flow run
  | { type: "reset" } // clear context (never counted)
  | { type: "help" } // show generic help (never counted)
  | { type: "reply"; userMsg: string } // counted generic small-talk reply
  | { type: "greet" } // counted offline greeting
  | { type: "silent" }; // handled, no reply (over budget / owner online / spent)

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
  // Scope: only unconfigured 1:1 DMs from saved, non-owner contacts.
  if (i.isGroup || i.isBroadcast) return { type: "pass" };
  if (i.isAdmin) return { type: "pass" };
  if (i.isAllowlisted) return { type: "pass" };
  if (!i.text) return { type: "pass" };
  if (i.text.startsWith("!!")) return { type: "pass" }; // reserved for admin/self
  if (!i.isSaved) return { type: "pass" };

  const isCommand = i.text.startsWith("!");
  if (isCommand) {
    const cmd = i.text.slice(1).trim().toLowerCase().split(/\s+/)[0];
    if (cmd === "reset") return { type: "reset" };
    if (cmd === "help") return { type: "help" };
    if (i.count >= i.limit) return { type: "silent" }; // budget spent
    return { type: "reply", userMsg: i.text.slice(1).trim() };
  }

  // Non-command message.
  if (i.count >= i.limit) return { type: "silent" }; // budget spent → go quiet
  if (i.count > 0) return { type: "silent" }; // first reply used; non-! now ignored
  if (i.ownerOnline) return { type: "silent" }; // owner active → don't step in
  return { type: "greet" }; // first response of the day: offline greeting
}
