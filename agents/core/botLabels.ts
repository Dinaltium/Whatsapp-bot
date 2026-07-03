/**
 * Canonical bot-number → display-name mapping. Single source of truth so the
 * numbering (0 = Generic default, 1 = ECB, 2 = DKB, 3 = PARAG) isn't
 * re-encoded as scattered ternaries.
 */
export const BOT_LABELS: Record<number, string> = {
  0: "Generic",
  1: "ECB",
  2: "DKB",
  3: "PARAG",
};

export function botLabel(n: number): string {
  return BOT_LABELS[n] ?? `Bot ${n}`;
}
