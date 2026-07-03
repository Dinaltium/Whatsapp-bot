import { describe, it, expect } from "vitest";
import { parseImageFlag } from "../../utils/imageFlag";

describe("parseImageFlag", () => {
  it("detects trailing -img and strips it", () => {
    const r = parseImageFlag("Who is the current trillionaire -img");
    expect(r.wantImage).toBe(true);
    expect(r.prompt).toBe("Who is the current trillionaire");
  });

  it("no flag → wantImage false, prompt unchanged", () => {
    const r = parseImageFlag("Who is the current trillionaire");
    expect(r.wantImage).toBe(false);
    expect(r.prompt).toBe("Who is the current trillionaire");
  });

  it('unescapes quoted "-" into a literal hyphen', () => {
    const r = parseImageFlag(
      'Who is the fastest runner in the world "-" in which country -img',
    );
    expect(r.wantImage).toBe(true);
    expect(r.prompt).toBe(
      "Who is the fastest runner in the world - in which country",
    );
  });

  it("does not treat a mid-string -img as the flag", () => {
    const r = parseImageFlag("what is -imgur used for");
    expect(r.wantImage).toBe(false);
    expect(r.prompt).toBe("what is -imgur used for");
  });

  it("handles -img as the whole prompt", () => {
    const r = parseImageFlag("-img");
    expect(r.wantImage).toBe(true);
    expect(r.prompt).toBe("");
  });
});
