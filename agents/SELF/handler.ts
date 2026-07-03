import { proto } from "@whiskeysockets/baileys";
import { UserSession } from "../../core/state";
import { AgentResult } from "../core/BotHandler";
import {
  SELF_SYSTEM_PROMPT,
  SELF_RATE_LIMIT,
  SELF_HELP_TEXT,
} from "./intro";
import {
  addReminder,
  getPendingReminders,
  deleteReminder,
} from "../../storage/SELF/reminderRepository";
import {
  parseReminderTime,
  parseReminderTimeWithAI,
} from "../../utils/timeParser";
import {
  getContextFromMessage,
  getRecentMessages,
} from "../../utils/contextWindow";
import {
  checkVoiceLimit,
  generateVoiceMessage,
} from "../../utils/voiceMessage";
import { searchWeb, requiresCurrentInfo } from "../../utils/webSearch";
import { parseImageFlag } from "../../utils/imageFlag";
import chatConfig from "../../config/chatAllowlist";
import { redis } from "../../storage/redisClient";
import { getGroqReply } from "../../ai/groqClient";
import * as fs from "fs";
import * as path from "path";

const GROQ_MODEL_SCOUT =
  process.env.GROQ_MODEL_SCOUT ||
  "meta-llama/llama-4-scout-17b-16e-instruct";
const GROQ_MODEL_DEFAULT = "llama-3.3-70b-versatile";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function nowIST(): Date {
  return new Date(Date.now() + IST_OFFSET_MS);
}

function formatISTDate(d: Date): string {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return ist.toISOString().replace("T", " ").slice(0, 16) + " IST";
}

function getDateKey(): string {
  return nowIST().toISOString().split("T")[0];
}

function loadDocFile(filename: string): string | null {
  try {
    const docPath = path.join(process.cwd(), "docs", filename);
    if (fs.existsSync(docPath)) {
      return fs.readFileSync(docPath, "utf-8");
    }
  } catch {
    // ignore
  }
  return null;
}



function getQuotedText(msg: proto.IWebMessageInfo): string | null {
  const ext = msg.message?.extendedTextMessage;
  if (!ext?.contextInfo?.quotedMessage) return null;
  const qm = ext.contextInfo.quotedMessage;
  return (
    qm.conversation ||
    qm.extendedTextMessage?.text ||
    qm.imageMessage?.caption ||
    null
  );
}

function getQuotedMsgId(msg: proto.IWebMessageInfo): string | null {
  return msg.message?.extendedTextMessage?.contextInfo?.stanzaId || null;
}

export async function handleMessage(
  session: UserSession,
  userPrompt: string,
  groqApiKey: string | undefined,
  groqModel: string,
  sock: any,
  msg: proto.IWebMessageInfo,
  from: string,
  senderId: string,
): Promise<AgentResult> {
  // ── SELF RATE LIMIT ──────────────────────────────────────────────────
  const selfRateKey = `self_rate:${senderId}:${Math.floor(Date.now() / 60000)}`;
  const count = await redis.incr(selfRateKey);
  if (count === 1) await redis.expire(selfRateKey, 120);
  if (count > SELF_RATE_LIMIT.maxRequests) {
    if (count === SELF_RATE_LIMIT.maxRequests + 1) {
      return {
        reply: `Rate limit: ${SELF_RATE_LIMIT.maxRequests} requests/minute. Slowing down.`,
        usedAI: false,
      };
    }
    return { reply: "", usedAI: false };
  }

  // ── SELF GROUP DAILY CAP ─────────────────────────────────────────────
  if (from.endsWith("@g.us")) {
    const groupKey = `self_group:${from}:${getDateKey()}`;
    const groupCount = await redis.incr(groupKey);
    if (groupCount === 1) await redis.expire(groupKey, 86400);
    if (groupCount > 30) {
      return { reply: "", usedAI: false };
    }
  }

  // Parse the trailing `-img` image-request flag (see parseImageFlag).
  const { wantImage, prompt: effectivePrompt } = parseImageFlag(userPrompt);

  const cmd = effectivePrompt.toLowerCase();
  const raw = effectivePrompt;

  // ── !!help ────────────────────────────────────────────────────────────
  if (cmd === "help") {
    return { reply: SELF_HELP_TEXT, usedAI: false };
  }

  // ── !!explain / !!howdoes / !!commands ───────────────────────────────
  if (
    cmd.startsWith("explain ") ||
    cmd.startsWith("howdoes ") ||
    cmd.startsWith("commands ")
  ) {
    const parts = raw.split(/\s+/);
    const topic = parts.slice(1).join(" ").toLowerCase();

    let docContent: string | null = null;
    if (topic.includes("parag") || topic.includes("bot 0")) {
      docContent = loadDocFile("bot-parag.md");
    } else if (
      topic.includes("dkb") ||
      topic.includes("dk24") ||
      topic.includes("bot 2")
    ) {
      docContent = loadDocFile("bot-dkb.md");
    } else if (
      topic.includes("ecb") ||
      topic.includes("embed") ||
      topic.includes("bot 1")
    ) {
      docContent = loadDocFile("bot-ecb.md");
    } else if (topic.includes("self") || topic.includes("admin")) {
      docContent = loadDocFile("bot-self.md");
    } else if (
      topic.includes("baileys") ||
      topic.includes("whatsapp") ||
      topic.includes("connection")
    ) {
      docContent = loadDocFile("baileys-overview.md");
    } else if (
      topic.includes("arch") ||
      topic.includes("router") ||
      topic.includes("system")
    ) {
      docContent = loadDocFile("architecture.md");
    } else {
      // If no specific doc is requested, load ALL documentation so the AI has 
      // complete architectural context and doesn't hallucinate its own tech stack
      const allDocs = [
        "architecture.md",
        "baileys-overview.md",
        "bot-parag.md",
        "bot-dkb.md",
        "bot-ecb.md",
        "bot-self.md",
      ];
      
      const combinedDocs = allDocs
        .map((d) => {
          const content = loadDocFile(d);
          return content ? `--- ${d} ---\n${content}` : null;
        })
        .filter((content) => content !== null)
        .join("\n\n");
        
      if (combinedDocs.trim().length > 0) {
        docContent = combinedDocs;
      }
    }

    if (!groqApiKey) {
      return {
        reply: docContent
          ? `${docContent.slice(0, 2000)}`
          : `No documentation found for "${topic}".`,
        usedAI: false,
      };
    }

    const systemPrompt = docContent
      ? `${SELF_SYSTEM_PROMPT}\n\nYou have been given documentation context. Answer based on it.\n\n${docContent}`
      : SELF_SYSTEM_PROMPT;

    const aiReply = await getGroqReply(
      [{ role: "user", content: `Explain: ${topic}` }],
      groqApiKey,
      GROQ_MODEL_DEFAULT,
      systemPrompt,
    );

    return { reply: `${aiReply}`, usedAI: true };
  }

  // ── !!remind <time> <message> ─────────────────────────────────────────
  if (cmd.startsWith("remind ")) {
    const rest = raw.slice("remind ".length).trim();
    // Try to split time from message
    // Strategy: try progressively longer time prefixes
    let parsedTime: Date | null = null;
    let reminderMsg = "";

    const words = rest.split(/\s+/);
    for (let i = 1; i <= Math.min(words.length - 1, 5); i++) {
      const timePart = words.slice(0, i).join(" ");
      const msgPart = words.slice(i).join(" ");
      const t = parseReminderTime(timePart);
      if (t) {
        parsedTime = t;
        reminderMsg = msgPart;
        break;
      }
    }

    // AI fallback for complex expressions
    if (!parsedTime && groqApiKey) {
      const words2 = rest.split(/\s+/);
      for (let i = 2; i <= Math.min(words2.length - 1, 6); i++) {
        const timePart = words2.slice(0, i).join(" ");
        const msgPart = words2.slice(i).join(" ");
        const t = await parseReminderTimeWithAI(timePart, groqApiKey);
        if (t) {
          parsedTime = t;
          reminderMsg = msgPart;
          break;
        }
      }
    }

    if (!parsedTime || !reminderMsg) {
      return {
        reply: `Could not parse reminder time.\nUsage: !!remind in 5 minutes call John\nOr: !!remind tomorrow 9am meeting`,
        usedAI: false,
      };
    }

    const id = await addReminder(senderId, from, reminderMsg, parsedTime);
    if (id) {
      return {
        reply: `Reminder set for ${formatISTDate(parsedTime)}: ${reminderMsg}`,
        usedAI: false,
      };
    } else {
      return {
        reply: `Failed to save reminder. Database may be unavailable.`,
        usedAI: false,
      };
    }
  }

  // ── !!reminders ───────────────────────────────────────────────────────
  if (cmd === "reminders") {
    const reminders = await getPendingReminders(senderId);
    if (!reminders.length) {
      return { reply: `No pending reminders.`, usedAI: false };
    }
    const lines = reminders.map(
      (r) => `ID: ${r.id} | ${r.message} | Due: ${formatISTDate(r.remind_at)}`,
    );
    return {
      reply: `Pending reminders:\n${lines.join("\n")}`,
      usedAI: false,
    };
  }

  // ── !!delremind <id> ──────────────────────────────────────────────────
  if (cmd.startsWith("delremind ")) {
    const idStr = raw.slice("delremind ".length).trim();
    const id = parseInt(idStr, 10);
    if (isNaN(id)) {
      return {
        reply: `Usage: !!delremind <id>`,
        usedAI: false,
      };
    }
    const ok = await deleteReminder(id, senderId);
    return {
      reply: ok
        ? `Reminder ${id} deleted.`
        : `Reminder ${id} not found.`,
      usedAI: false,
    };
  }

  // ── !!translate all <lang> (reply) ────────────────────────────────────
  if (cmd.startsWith("translate all ")) {
    const lang = raw.slice("translate all ".length).trim();
    const quotedMsgId = getQuotedMsgId(msg);
    if (!quotedMsgId || !groqApiKey) {
      return {
        reply: `Reply to a message with !!translate all <lang> to translate the thread.`,
        usedAI: false,
      };
    }
    const messages = await getContextFromMessage(from, quotedMsgId, 30);
    if (!messages.length) {
      return {
        reply: `No context found from that message.`,
        usedAI: false,
      };
    }
    const prompt =
      `Translate each of these messages to ${lang}. Format: [SenderName]: <translated text>\n\n` +
      messages
        .reverse()
        .map((m) => `[${m.senderName}]: ${m.text}`)
        .join("\n");
    const aiReply = await getGroqReply(
      [{ role: "user", content: prompt }],
      groqApiKey,
      GROQ_MODEL_DEFAULT,
      SELF_SYSTEM_PROMPT,
    );
    return { reply: `${aiReply}`, usedAI: true };
  }

  // ── !!translate <lang> <text> (or reply) ─────────────────────────────
  if (cmd.startsWith("translate ")) {
    const rest = raw.slice("translate ".length).trim();
    const parts = rest.split(/\s+/);
    const lang = parts[0];
    const quotedText = getQuotedText(msg);
    const textToTranslate = quotedText || parts.slice(1).join(" ");

    if (!lang || !textToTranslate) {
      return {
        reply: `Usage: !!translate <lang> <text> (or reply to a message)`,
        usedAI: false,
      };
    }
    if (!groqApiKey) {
      return {
        reply: `Groq API key missing for translation.`,
        usedAI: false,
      };
    }
    const aiReply = await getGroqReply(
      [{ role: "user", content: `Translate to ${lang}: ${textToTranslate}` }],
      groqApiKey,
      GROQ_MODEL_DEFAULT,
      SELF_SYSTEM_PROMPT,
    );
    return { reply: `${aiReply}`, usedAI: true };
  }

  // ── !!context / !!summarize (reply) ──────────────────────────────────
  if (cmd === "context" || cmd === "summarize") {
    const quotedMsgId = getQuotedMsgId(msg);
    if (!groqApiKey) {
      return {
        reply: `Groq API key missing.`,
        usedAI: false,
      };
    }
    let messages;
    if (quotedMsgId) {
      messages = await getContextFromMessage(from, quotedMsgId, 30);
    } else {
      messages = await getRecentMessages(from, 20);
    }
    if (!messages.length) {
      return {
        reply: `No cached context available for this chat.`,
        usedAI: false,
      };
    }
    const prompt =
      `Summarize this conversation thread (${messages.length} messages):\n\n` +
      messages
        .reverse()
        .map((m) => `[${m.senderName}]: ${m.text}`)
        .join("\n");
    const aiReply = await getGroqReply(
      [{ role: "user", content: prompt }],
      groqApiKey,
      GROQ_MODEL_DEFAULT,
      SELF_SYSTEM_PROMPT,
    );
    return {
      reply: `Context Summary (${messages.length} messages):\n\n${aiReply}`,
      usedAI: true,
    };
  }

  // ── !!tldr [count] ────────────────────────────────────────────────────
  if (cmd === "tldr" || cmd.startsWith("tldr ")) {
    const countStr = raw.slice("tldr".length).trim();
    const count2 = parseInt(countStr || "20", 10);
    if (!groqApiKey) {
      return { reply: `Groq API key missing.`, usedAI: false };
    }
    const messages = await getRecentMessages(
      from,
      isNaN(count2) ? 20 : count2,
    );
    if (!messages.length) {
      return {
        reply: `No cached messages available.`,
        usedAI: false,
      };
    }
    const prompt =
      `TL;DR of the last ${messages.length} messages:\n\n` +
      messages
        .reverse()
        .map((m) => `[${m.senderName}]: ${m.text}`)
        .join("\n");
    const aiReply = await getGroqReply(
      [{ role: "user", content: prompt }],
      groqApiKey,
      GROQ_MODEL_DEFAULT,
      SELF_SYSTEM_PROMPT,
    );
    return { reply: `${aiReply}`, usedAI: true };
  }

  // ── !!tone (reply) ────────────────────────────────────────────────────
  if (cmd === "tone") {
    const quotedText = getQuotedText(msg);
    if (!quotedText) {
      return {
        reply: `Reply to a message with !!tone to detect its emotional tone.`,
        usedAI: false,
      };
    }
    if (!groqApiKey) {
      return { reply: `Groq API key missing.`, usedAI: false };
    }
    const aiReply = await getGroqReply(
      [
        {
          role: "user",
          content: `Detect the emotional tone of this message. Reply with ONLY one of: aggressive, formal, casual, sarcastic, friendly, neutral.\n\nMessage: ${quotedText}`,
        },
      ],
      groqApiKey,
      GROQ_MODEL_DEFAULT,
      SELF_SYSTEM_PROMPT,
    );
    return { reply: `Tone: ${aiReply.trim()}`, usedAI: true };
  }

  // ── !!find <keyword> ─────────────────────────────────────────────────
  if (cmd.startsWith("find ")) {
    const keyword = raw.slice("find ".length).trim().toLowerCase();
    if (!keyword) {
      return {
        reply: `Usage: !!find <keyword>`,
        usedAI: false,
      };
    }
    const messages = await getRecentMessages(from, 100);
    const matches = messages.filter((m) =>
      m.text.toLowerCase().includes(keyword),
    );
    if (!matches.length) {
      return {
        reply: `No messages found containing "${keyword}".`,
        usedAI: false,
      };
    }
    const lines = matches.slice(0, 10).map((m) => {
      const ts = new Date(m.timestamp + IST_OFFSET_MS)
        .toISOString()
        .slice(11, 16);
      return `[${ts} IST] ${m.senderName}: ${m.text.slice(0, 120)}`;
    });
    return {
      reply: `Found ${matches.length} message(s) containing "${keyword}":\n\n${lines.join("\n")}`,
      usedAI: false,
    };
  }

  // ── !!voice [-id <n>] <text> (or reply) ───────────────────────────────
  // Optional `-id <n>` routes the voice note to saved chat-allowlist entry n
  // (same id space as !listchats) instead of the current chat.
  if (cmd.startsWith("voice") && (cmd === "voice" || cmd.startsWith("voice "))) {
    const voiceArgs = raw.slice("voice".length).trim();

    let destJid = from;
    let destLabel = "this chat";
    let spokenArgs = voiceArgs;

    const idMatch = voiceArgs.match(/^-id\s+(\d+)\s*([\s\S]*)$/i);
    if (idMatch) {
      const chatId = parseInt(idMatch[1], 10);
      spokenArgs = idMatch[2].trim();
      const entry = chatConfig.getChatEntryById(chatId);
      if (!entry) {
        return {
          reply: `No saved chat found with id ${chatId}. Use !listchats to see ids.`,
          usedAI: false,
        };
      }
      destJid = entry.jid;
      destLabel = `+${entry.jid.split("@")[0]}`;
    }

    const quotedText = getQuotedText(msg);
    const textToSpeak = quotedText || spokenArgs;

    if (!textToSpeak) {
      return {
        reply: `Usage: !!voice [-id <n>] <text> (or reply to a message). Use !listchats for ids.`,
        usedAI: false,
      };
    }
    if (!groqApiKey) {
      return {
        reply: `Groq API key missing for TTS.`,
        usedAI: false,
      };
    }

    // Daily voice limit is global across all destinations (a single leash),
    // so routing to different ids can't multiply the cap.
    const limitCheck = await checkVoiceLimit();
    if (!limitCheck.allowed) {
      return {
        reply: `Voice limit reached today (${limitCheck.count}/${SELF_RATE_LIMIT.voiceDailyLimit}). Resets at midnight IST.`,
        usedAI: false,
      };
    }

    const result = await generateVoiceMessage(textToSpeak, groqApiKey);
    if (!result.success || !result.audioBuffer) {
      console.error("[SELF] Voice generation failed:", result.error);
      return {
        reply: `Voice generation failed. Groq TTS may be temporarily unavailable.`,
        usedAI: false,
      };
    }

    try {
      await sock.sendMessage(destJid, {
        audio: result.audioBuffer,
        mimetype: "audio/wav",
        ptt: true,
      });
    } catch (err) {
      console.error("[SELF] Failed to send voice message:", err);
      return {
        reply: `Voice generated but failed to send.`,
        usedAI: false,
      };
    }
    // Confirm to the operator when the note went somewhere other than here.
    return {
      reply: destJid === from ? "" : `Voice note sent to ${destLabel}.`,
      usedAI: false,
    };
  }

  // ── !!reply <style> (reply) ───────────────────────────────────────────
  if (cmd.startsWith("reply ")) {
    const style = raw.slice("reply ".length).trim().toLowerCase();
    const quotedText = getQuotedText(msg);
    if (!quotedText) {
      return {
        reply: `Reply to a message with !!reply <style>. Styles: formal, casual, decline, agree`,
        usedAI: false,
      };
    }
    if (!groqApiKey) {
      return { reply: `Groq API key missing.`, usedAI: false };
    }
    const aiReply = await getGroqReply(
      [
        {
          role: "user",
          content: `Draft a ${style} reply to this message: "${quotedText}"`,
        },
      ],
      groqApiKey,
      GROQ_MODEL_DEFAULT,
      SELF_SYSTEM_PROMPT,
    );
    return {
      reply: `Draft reply (${style}):\n${aiReply}`,
      usedAI: true,
    };
  }

  // ── !!search <query> ─────────────────────────────────────────────────
  if (cmd.startsWith("search ")) {
    const query = raw.slice("search ".length).trim();
    if (!query) {
      return {
        reply: `Usage: !!search <query>`,
        usedAI: false,
      };
    }
    
    console.info(`[SELF] Executing explicit web search for query: "${query}"`);
    const searchContext = await searchWeb(query);
    
    if (!searchContext) {
      return {
        reply: `Web search failed or no results found for "${query}". Ensure search API keys (TAVILY_API_KEY or FIRECRAWL_API_KEY) are configured in the environment.`,
        usedAI: false,
      };
    }

    if (!groqApiKey) {
      return {
        reply: `${searchContext}`,
        usedAI: false,
      };
    }
    const systemWithSearch = `${SELF_SYSTEM_PROMPT}\n\nCurrent Date & Time (IST): ${formatISTDate(nowIST())}\n\nWeb search results:\n${searchContext}`;
    const aiReply = await getGroqReply(
      [{ role: "user", content: query }],
      groqApiKey,
      GROQ_MODEL_SCOUT,
      systemWithSearch,
    );
    return { reply: `${aiReply}`, usedAI: true };
  }

  // ── General AI (with optional web search for current info) ───────────
  if (!groqApiKey) {
    return {
      reply: `Groq API key missing.`,
      usedAI: false,
    };
  }

  let systemPrompt = `${SELF_SYSTEM_PROMPT}\n\nCurrent Date & Time (IST): ${formatISTDate(nowIST())}`;
  let modelToUse = GROQ_MODEL_DEFAULT;

  // Query classification: DK24-community questions are answerable from Postgres
  // (clubs/events/mentors/projects), so answer from the local DB context instead
  // of burning a live web-search API call — even though they may match the
  // "current info" pattern (e.g. "who is the mentor for X").
  const { isCommunityQuery } = await import("../../services/DKB/communityService");
  if (isCommunityQuery(raw)) {
    console.info(`[SELF] Community query — using DK24 DB context instead of web search.`);
    const { buildDynamicContextPrompt } = await import("../../ai/promptBuilder");
    const dbContext = await buildDynamicContextPrompt(raw);
    systemPrompt = `${SELF_SYSTEM_PROMPT}\n\nCurrent Date & Time (IST): ${formatISTDate(nowIST())}\n\nDK24 community database:\n${dbContext}`;
    modelToUse = GROQ_MODEL_DEFAULT;
  } else if (requiresCurrentInfo(raw)) {
    console.info(`[SELF] Current info pattern detected in prompt. Triggering web search.`);
    const searchContext = await searchWeb(raw);

    if (searchContext) {
      console.info(`[SELF] Successfully retrieved web context. Injecting into system prompt and switching to scout model.`);
      systemPrompt = `${SELF_SYSTEM_PROMPT}\n\nCurrent Date & Time (IST): ${formatISTDate(nowIST())}\n\nReal-time web search results:\n${searchContext}`;
      modelToUse = GROQ_MODEL_SCOUT;
    } else {
      console.warn(`[SELF] Web search was triggered but returned no results.`);
      systemPrompt = `${SELF_SYSTEM_PROMPT}\n\nCurrent Date & Time (IST): ${formatISTDate(nowIST())}\n\n[SYSTEM WARNING: A web search was attempted for this query but failed. Please inform the user that you cannot access the live web right now and your knowledge may be outdated.]`;
    }
  } else {
    console.debug(`[SELF] No current info pattern detected. Proceeding with standard generation.`);
  }

  // Use last 8 session messages as context
  const conversationMessages = [
    ...session.messages.slice(-8),
    { role: "user" as const, content: raw },
  ];

  const aiReply = await getGroqReply(
    conversationMessages,
    groqApiKey,
    modelToUse,
    systemPrompt,
  );

  // -img: attach a reference image with the answer as its caption (one message).
  // Falls back to text-only if no image is found or the send fails.
  if (wantImage) {
    try {
      const { fetchReferenceImage } = await import("../../utils/webSearch");
      const imgUrl = await fetchReferenceImage(raw);
      if (imgUrl) {
        const { scrubSecrets } = await import("../../security/secretScrubber");
        await sock.sendMessage(from, {
          image: { url: imgUrl },
          caption: scrubSecrets(aiReply).scrubbed,
        });
        return { reply: "", usedAI: true };
      }
    } catch (err) {
      console.error(
        "[SELF] -img image fetch/send failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { reply: `${aiReply}`, usedAI: true };
}

