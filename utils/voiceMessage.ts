import { redis } from "../storage/redisClient";

export interface VoiceResult {
  success: boolean;
  audioBuffer?: Buffer;
  error?: string;
}

const VOICE_DAILY_LIMIT = 90; // leaves buffer before Groq's 100/day hard limit

function getDateKey(): string {
  return new Date().toISOString().split("T")[0]; // YYYY-MM-DD UTC
}

export async function checkVoiceLimit(): Promise<{ allowed: boolean; count: number }> {
  const key = `voice_daily:${getDateKey()}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 86400);
    if (count > VOICE_DAILY_LIMIT) {
      // Decrement since we won't actually use it
      await redis.decr(key);
      return { allowed: false, count: count - 1 };
    }
    return { allowed: true, count };
  } catch (err) {
    console.warn("[VoiceMessage] Redis error in checkVoiceLimit:", err);
    return { allowed: true, count: 0 }; // fail open
  }
}

export async function generateVoiceMessage(
  text: string,
  groqApiKey: string,
): Promise<VoiceResult> {
  try {
    const fetchFn = (globalThis as any).fetch ?? (await import("node-fetch")).default;
    const res = await fetchFn("https://api.groq.com/openai/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${groqApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "canopylabs/orpheus-arabic-saudi",
        input: text,
        response_format: "wav",
        voice: "sultan",
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => String(res.status));
      return { success: false, error: `TTS API error: ${res.status} - ${errText}` };
    }

    const arrayBuf = await res.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuf);
    return { success: true, audioBuffer };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `TTS exception: ${msg}` };
  }
}
