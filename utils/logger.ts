import { createHash } from "crypto";

export function getJidHash(jid?: string | null): string {
  if (!jid) return "unknown";
  return createHash("sha256").update(jid).digest("hex").substring(0, 8);
}

export function logStructured(data: Record<string, any>): void {
  console.log(JSON.stringify(data));
}
