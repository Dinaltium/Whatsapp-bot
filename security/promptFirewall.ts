export function sanitizeForPrompt(input?: any): string {
  if (input === undefined || input === null) return "";
  return String(input)
    .replace(/ignore\s+all\s+previous\s+instructions/gi, "")
    .replace(/ignore\s+previous\s+instructions/gi, "")
    .replace(/system\s+prompt/gi, "")
    .replace(/ignore\s+instructions/gi, "")
    .replace(/you\s+must\s+now/gi, "")
    .replace(/<\/?[^>]+(>|$)/g, "") // strip html/xml tag boundaries to prevent prompt jailbreaks
    .trim();
}

export function hasPromptInjection(input: string): boolean {
  if (!input) return false;
  const lower = input.toLowerCase();
  const injectionPatterns = [
    /ignore\s+(?:all\s+)?(?:previous\s+)?(?:instructions|directives|rules|guidelines|guardrails|prompts)/i,
    /system\s+prompt/i,
    /bypass\s+(?:the\s+)?(?:guardrails|rules|system|security)/i,
    /you\s+must\s+now/i,
    /disregard\s+prior/i,
    /override\s+instructions/i,
    /acting\s+as\s+an?/i,
  ];
  return injectionPatterns.some((pattern) => pattern.test(lower));
}

