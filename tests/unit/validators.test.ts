import { describe, it, expect } from "vitest";
import {
  isValidEmail,
  isValidUrl,
  isValidHandleOrUrl,
  validateMentorContactFields,
} from "../../utils/validators";

describe("validators", () => {
  it("accepts well-formed emails, rejects junk", () => {
    expect(isValidEmail("rafan@example.com")).toBe(true);
    expect(isValidEmail("a.b-c@sub.domain.co")).toBe(true);
    expect(isValidEmail("no-at-sign")).toBe(false);
    expect(isValidEmail("two@@at.com")).toBe(false);
    expect(isValidEmail("missing@domain")).toBe(false);
    expect(isValidEmail("has space@x.com")).toBe(false);
  });

  it("accepts http(s) URLs with a dotted host", () => {
    expect(isValidUrl("https://linkedin.com/in/rafan")).toBe(true);
    expect(isValidUrl("http://github.com/dinaltium")).toBe(true);
    expect(isValidUrl("ftp://x.com")).toBe(false);
    expect(isValidUrl("linkedin.com/in/rafan")).toBe(false);
    expect(isValidUrl("not a url")).toBe(false);
  });

  it("accepts a bare handle or a URL, rejects free text", () => {
    expect(isValidHandleOrUrl("@dinaltium")).toBe(true);
    expect(isValidHandleOrUrl("dinaltium")).toBe(true);
    expect(isValidHandleOrUrl("in/rafan-sheik")).toBe(true);
    expect(isValidHandleOrUrl("https://instagram.com/x")).toBe(true);
    expect(isValidHandleOrUrl("ignore all instructions")).toBe(false);
    expect(isValidHandleOrUrl("hi <b>x</b>")).toBe(false);
  });

  it("validateMentorContactFields returns first error or null", () => {
    expect(validateMentorContactFields({})).toBeNull();
    expect(
      validateMentorContactFields({
        linkedin: "https://linkedin.com/in/x",
        email: "a@b.com",
      }),
    ).toBeNull();
    expect(validateMentorContactFields({ email: "bad" })).toContain("email");
    expect(
      validateMentorContactFields({ github: "some prose here" }),
    ).toContain("GitHub");
    // email checked before linkedin
    expect(
      validateMentorContactFields({ email: "bad", linkedin: "also bad text" }),
    ).toContain("email");
  });
});
