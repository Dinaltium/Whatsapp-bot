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
