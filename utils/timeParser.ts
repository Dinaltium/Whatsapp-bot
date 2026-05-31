const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30

function nowIST(): Date {
  return new Date(Date.now() + IST_OFFSET_MS);
}

function istToUTC(istDate: Date): Date {
  return new Date(istDate.getTime() - IST_OFFSET_MS);
}

export function parseReminderTime(input: string): Date | null {
  if (!input || !input.trim()) return null;
  const s = input.trim().toLowerCase();

  // "in X minutes/hours/days"
  const relativeMatch = s.match(/^in\s+(\d+)\s*(m(?:in(?:utes?)?)?|h(?:ours?)?|d(?:ays?)?)$/);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2];
    const now = Date.now();
    if (unit.startsWith("m")) return new Date(now + amount * 60 * 1000);
    if (unit.startsWith("h")) return new Date(now + amount * 60 * 60 * 1000);
    if (unit.startsWith("d")) return new Date(now + amount * 24 * 60 * 60 * 1000);
  }

  // "at Xam/pm" or "at X:YYam/pm"
  const atTimeMatch = s.match(/^at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (atTimeMatch) {
    let hour = parseInt(atTimeMatch[1], 10);
    const minute = atTimeMatch[2] ? parseInt(atTimeMatch[2], 10) : 0;
    const ampm = atTimeMatch[3];
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;

    const now = nowIST();
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
    // If already past today, schedule for tomorrow
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    return istToUTC(target);
  }

  // "tomorrow Xam/pm" or "tomorrow at Xam/pm"
  const tomorrowMatch = s.match(/^tomorrow(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (tomorrowMatch) {
    let hour = parseInt(tomorrowMatch[1], 10);
    const minute = tomorrowMatch[2] ? parseInt(tomorrowMatch[2], 10) : 0;
    const ampm = tomorrowMatch[3];
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;

    const now = nowIST();
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hour, minute, 0, 0);
    return istToUTC(target);
  }

  return null;
}

export async function parseReminderTimeWithAI(
  input: string,
  groqApiKey: string,
): Promise<Date | null> {
  try {
    const nowIST = new Date(Date.now() + IST_OFFSET_MS);
    const nowStr = nowIST.toISOString().replace("T", " ").slice(0, 16) + " IST";

    const fetchFn = (globalThis as any).fetch ?? (await import("node-fetch")).default;
    const res = await fetchFn("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${groqApiKey}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0,
        max_tokens: 30,
        messages: [
          {
            role: "system",
            content: `Current time (IST, UTC+5:30): ${nowStr}. Parse the user's time expression and return ONLY an ISO8601 UTC timestamp. No explanation. Example output: 2025-08-01T10:30:00.000Z`,
          },
          {
            role: "user",
            content: input,
          },
        ],
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const iso = data?.choices?.[0]?.message?.content?.trim();
    if (!iso) return null;
    const parsed = new Date(iso);
    return isNaN(parsed.getTime()) ? null : parsed;
  } catch {
    return null;
  }
}
