import { describe, it, expect } from "vitest";
import { scrubSecrets } from "../../security/secretScrubber";

describe("secretScrubber", () => {
  it("redacts secret-shaped strings", () => {
    const r = scrubSecrets("key is gsk_abcdefghijklmnopqrstuvwx1234 ok");
    expect(r.scrubbed).toContain("[REDACTED:GROQ_KEY]");
    expect(r.scrubbed).not.toContain("gsk_abcdefghijklmnopqrstuvwx1234");
    expect(r.hits).toContain("GROQ_KEY");
  });

  it("redacts DB/redis URLs and JWTs", () => {
    expect(
      scrubSecrets("postgres://u:p@host/db?sslmode=require").scrubbed,
    ).toContain("[REDACTED:POSTGRES_URL]");
    expect(scrubSecrets("redis://default:pw@host:6379").scrubbed).toContain(
      "[REDACTED:REDIS_URL]",
    );
    expect(
      scrubSecrets(
        "token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36 here",
      ).scrubbed,
    ).toContain("[REDACTED:JWT]");
  });

  it("leaves normal text and PII (emails/phones) intact", () => {
    const r = scrubSecrets("Contact mentor Rafan at rafan@example.com / +919902849280");
    expect(r.scrubbed).toBe(
      "Contact mentor Rafan at rafan@example.com / +919902849280",
    );
    expect(r.hits).toEqual([]);
  });

  it("handles empty input", () => {
    expect(scrubSecrets("").scrubbed).toBe("");
    expect(scrubSecrets("").hits).toEqual([]);
  });
});
