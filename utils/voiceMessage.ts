import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";
import { redis } from "../storage/redisClient";

export interface VoiceResult {
  success: boolean;
  audioBuffer?: Buffer;
  mimetype?: string;
  error?: string;
}

const VOICE_DAILY_LIMIT = 90; // leaves buffer before Groq's 100/day hard limit

// WhatsApp voice notes (ptt) must be OGG/Opus — sending WAV/mp3 with ptt:true
// is accepted by the socket but dropped by WhatsApp's server, so it never
// arrives. This is the mimetype the buffer is transcoded to.
export const VOICE_NOTE_MIMETYPE = "audio/ogg; codecs=opus";

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

/** Transcodes an audio buffer (e.g. WAV) to mono OGG/Opus for a WhatsApp ptt note. */
function transcodeToOpusOgg(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const bin = (ffmpegPath as string) || "ffmpeg";
    const ff = spawn(bin, [
      "-hide_banner",
      "-loglevel", "error",
      "-i", "pipe:0",
      "-ac", "1",
      "-c:a", "libopus",
      "-b:a", "32k",
      "-f", "ogg",
      "pipe:1",
    ]);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    ff.stdout.on("data", (d) => out.push(d));
    ff.stderr.on("data", (d) => err.push(d));
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code === 0 && out.length) {
        resolve(Buffer.concat(out));
      } else {
        reject(
          new Error(
            `ffmpeg exited ${code}: ${Buffer.concat(err).toString().slice(-300)}`,
          ),
        );
      }
    });
    ff.stdin.on("error", () => {
      /* EPIPE if ffmpeg dies early — surfaced via close */
    });
    ff.stdin.write(input);
    ff.stdin.end();
  });
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
    const wavBuffer = Buffer.from(arrayBuf);

    // Transcode WAV -> OGG/Opus so it delivers as a real WhatsApp voice note.
    try {
      const opus = await transcodeToOpusOgg(wavBuffer);
      return { success: true, audioBuffer: opus, mimetype: VOICE_NOTE_MIMETYPE };
    } catch (transErr) {
      const m = transErr instanceof Error ? transErr.message : String(transErr);
      console.error("[VoiceMessage] Opus transcode failed:", m);
      return {
        success: false,
        error: `Voice transcode failed (ffmpeg): ${m}`,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `TTS exception: ${msg}` };
  }
}
