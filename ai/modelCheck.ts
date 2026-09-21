/**
 * Boot-time sanity check: is the configured Groq model actually served?
 *
 * Groq retires models without a deprecation period — requests just start
 * failing with `model_not_found`. Catching that at startup turns a silent
 * outage into one loud log line (and a dashboard warning).
 */

export interface ModelCheckResult {
  checkedAt: number;
  models: { id: string; ok: boolean }[];
  available: string[] | null; // null = could not reach Groq
  error: string | null;
}

let last: ModelCheckResult | null = null;

export function getLastModelCheck(): ModelCheckResult | null {
  return last;
}

/** Pure: which of `wanted` are missing from `available`? Exported for tests. */
export function missingModels(wanted: string[], available: string[]): string[] {
  const set = new Set(available);
  return wanted.filter((m) => !set.has(m));
}

export async function checkGroqModels(
  apiKey: string | undefined,
  wanted: string[],
  fetchFn: typeof fetch = fetch,
): Promise<ModelCheckResult> {
  const unique = Array.from(new Set(wanted.filter(Boolean)));
  const result: ModelCheckResult = {
    checkedAt: Date.now(),
    models: unique.map((id) => ({ id, ok: true })),
    available: null,
    error: null,
  };

  if (!apiKey) {
    result.error = "GROQ_API_KEY not set";
    last = result;
    return result;
  }

  try {
    const res = await fetchFn("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      result.error = `Groq /models returned ${res.status}`;
      last = result;
      return result;
    }
    const body: any = await res.json();
    const available: string[] = (body?.data || []).map((m: any) => String(m.id));
    result.available = available;
    const missing = new Set(missingModels(unique, available));
    result.models = unique.map((id) => ({ id, ok: !missing.has(id) }));
    if (missing.size) {
      console.error(
        `[models] Not served by Groq: ${Array.from(missing).join(", ")}. ` +
          `Requests using them will 404. Update GROQ_MODEL / GROQ_MODEL_SCOUT.`,
      );
    } else {
      console.log(`[models] Groq serves all configured models: ${unique.join(", ")}`);
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    console.warn(`[models] Could not verify Groq models: ${result.error}`);
  }
  last = result;
  return result;
}
