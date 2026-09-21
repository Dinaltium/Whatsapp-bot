import { describe, it, expect } from "vitest";
import { checkGroqModels, missingModels, getLastModelCheck } from "../../ai/modelCheck";

function fakeFetch(status: number, ids: string[]): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ data: ids.map((id) => ({ id })) }),
    }) as any) as typeof fetch;
}

describe("missingModels", () => {
  it("returns only the configured models Groq does not list", () => {
    expect(missingModels(["a", "b", "c"], ["a", "c", "z"])).toEqual(["b"]);
    expect(missingModels(["a"], ["a"])).toEqual([]);
  });
});

describe("checkGroqModels", () => {
  it("flags a retired model and records the result", async () => {
    const r = await checkGroqModels("key", ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"], fakeFetch(200, ["openai/gpt-oss-120b"]));
    expect(r.models).toEqual([
      { id: "openai/gpt-oss-120b", ok: true },
      { id: "llama-3.3-70b-versatile", ok: false },
    ]);
    expect(r.error).toBeNull();
    expect(getLastModelCheck()).toBe(r);
  });

  it("does not mark models bad when Groq itself is unreachable", async () => {
    const r = await checkGroqModels("key", ["x"], fakeFetch(503, []));
    expect(r.models).toEqual([{ id: "x", ok: true }]);
    expect(r.error).toMatch(/503/);
  });

  it("reports a missing API key instead of calling out", async () => {
    let called = false;
    const r = await checkGroqModels(undefined, ["x"], (async () => {
      called = true;
      return {} as any;
    }) as typeof fetch);
    expect(called).toBe(false);
    expect(r.error).toMatch(/GROQ_API_KEY/);
  });

  it("dedupes when scout and main are the same model", async () => {
    const r = await checkGroqModels("key", ["m", "m"], fakeFetch(200, ["m"]));
    expect(r.models).toHaveLength(1);
  });
});
