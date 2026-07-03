/**
 * Lightweight format validators for user-submitted mentor contact fields.
 *
 * Goal: reject free-text / garbage (and thus prompt-injection payloads) in
 * fields meant to hold a URL, social handle, or email. These are intentionally
 * lenient — not strict RFC validators — but they require the value to *look
 * like* what the field is for, which blocks arbitrary prose.
 */

export function isValidEmail(value: string): boolean {
  const v = value.trim();
  return v.length <= 100 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

export function isValidUrl(value: string): boolean {
  const v = value.trim();
  if (!/^https?:\/\//i.test(v)) return false;
  try {
    const u = new URL(v);
    return u.hostname.includes(".");
  } catch {
    return false;
  }
}

/**
 * A social profile value: either a full http(s) URL or a bare handle/path with
 * no whitespace and only safe characters. Anything with spaces or injection-y
 * punctuation (<, >, quotes, etc.) is rejected.
 */
export function isValidHandleOrUrl(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (isValidUrl(v)) return true;
  return /^@?[A-Za-z0-9._/-]{1,100}$/.test(v);
}

export interface ContactFields {
  linkedin?: string;
  github?: string;
  instagram?: string;
  email?: string;
}

/**
 * Returns an error message for the first invalid contact field, or null if
 * every provided field is well-formed. Empty/undefined fields are skipped.
 */
export function validateMentorContactFields(
  fields: ContactFields,
): string | null {
  if (fields.email && !isValidEmail(fields.email)) {
    return `Invalid email "${fields.email}". Expected something like name@example.com.`;
  }
  if (fields.linkedin && !isValidHandleOrUrl(fields.linkedin)) {
    return `Invalid LinkedIn "${fields.linkedin}". Provide a URL or handle with no spaces.`;
  }
  if (fields.github && !isValidHandleOrUrl(fields.github)) {
    return `Invalid GitHub "${fields.github}". Provide a URL or handle with no spaces.`;
  }
  if (fields.instagram && !isValidHandleOrUrl(fields.instagram)) {
    return `Invalid Instagram "${fields.instagram}". Provide a URL or handle with no spaces.`;
  }
  return null;
}
