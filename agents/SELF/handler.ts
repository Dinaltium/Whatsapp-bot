import { proto } from "@whiskeysockets/baileys";
import { UserSession } from "../../core/state";
import { AgentResult } from "../core/BotHandler";
import {
  SELF_SYSTEM_PROMPT,
  SELF_HEADER,
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
        reply: `${SELF_HEADER} Rate limit: ${SELF_RATE_LIMIT.maxRequests} requests/minute. Slowing down.`,
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

  const cmd = userPrompt.trim().toLowerCase();
  const raw = userPrompt.trim();

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
      // Try to load any doc containing the topic
      const allDocs = [
        "architecture.md",
        "baileys-overview.md",
        "bot-parag.md",
        "bot-dkb.md",
        "bot-ecb.md",
        "bot-self.md",
      ];
      for (const d of allDocs) {
        const content = loadDocFile(d);
        if (content && content.toLowerCase().includes(topic)) {
          docContent = content;
          break;
        }
      }
    }

    if (!groqApiKey) {
      return {
        reply: docContent
          ? `${SELF_HEADER}\n\n${docContent.slice(0, 2000)}`
          : `${SELF_HEADER} No documentation found for "${topic}".`,
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

    return { reply: `${SELF_HEADER}\n\n${aiReply}`, usedAI: true };
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
        reply: `${SELF_HEADER} Could not parse reminder time.\nUsage: !!remind in 5 minutes call John\nOr: !!remind tomorrow 9am meeting`,
        usedAI: false,
      };
    }

    const id = await addReminder(senderId, from, reminderMsg, parsedTime);
    if (id) {
      return {
        reply: `${SELF_HEADER} Reminder set for ${formatISTDate(parsedTime)}: ${reminderMsg}`,
        usedAI: false,
      };
    } else {
      return {
        reply: `${SELF_HEADER} Failed to save reminder. Database may be unavailable.`,
        usedAI: false,
      };
    }
  }

  // ── !!reminders ───────────────────────────────────────────────────────
  if (cmd === "reminders") {
    const reminders = await getPendingReminders(senderId);
    if (!reminders.length) {
      return { reply: `${SELF_HEADER} No pending reminders.`, usedAI: false };
    }
    const lines = reminders.map(
      (r) => `ID: ${r.id} | ${r.message} | Due: ${formatISTDate(r.remind_at)}`,
    );
    return {
      reply: `${SELF_HEADER} Pending reminders:\n${lines.join("\n")}`,
      usedAI: false,
    };
  }

  // ── !!delremind <id> ──────────────────────────────────────────────────
  if (cmd.startsWith("delremind ")) {
    const idStr = raw.slice("delremind ".length).trim();
    const id = parseInt(idStr, 10);
    if (isNaN(id)) {
      return {
        reply: `${SELF_HEADER} Usage: !!delremind <id>`,
        usedAI: false,
      };
    }
    const ok = await deleteReminder(id, senderId);
    return {
      reply: ok
        ? `${SELF_HEADER} Reminder ${id} deleted.`
        : `${SELF_HEADER} Reminder ${id} not found.`,
      usedAI: false,
    };
  }

  // ── !!translate all <lang> (reply) ────────────────────────────────────
  if (cmd.startsWith("translate all ")) {
    const lang = raw.slice("translate all ".length).trim();
    const quotedMsgId = getQuotedMsgId(msg);
    if (!quotedMsgId || !groqApiKey) {
      return {
        reply: `${SELF_HEADER} Reply to a message with !!translate all <lang> to translate the thread.`,
        usedAI: false,
      };
    }
    const messages = await getContextFromMessage(from, quotedMsgId, 30);
    if (!messages.length) {
      return {
        reply: `${SELF_HEADER} No context found from that message.`,
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
    return { reply: `${SELF_HEADER}\n\n${aiReply}`, usedAI: true };
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
        reply: `${SELF_HEADER} Usage: !!translate <lang> <text> (or reply to a message)`,
        usedAI: false,
      };
    }
    if (!groqApiKey) {
      return {
        reply: `${SELF_HEADER} Groq API key missing for translation.`,
        usedAI: false,
      };
    }
    const aiReply = await getGroqReply(
      [{ role: "user", content: `Translate to ${lang}: ${textToTranslate}` }],
      groqApiKey,
      GROQ_MODEL_DEFAULT,
      SELF_SYSTEM_PROMPT,
    );
    return { reply: `${SELF_HEADER}\n\n${aiReply}`, usedAI: true };
  }

  // ── !!context / !!summarize (reply) ──────────────────────────────────
  if (cmd === "context" || cmd === "summarize") {
    const quotedMsgId = getQuotedMsgId(msg);
    if (!groqApiKey) {
      return {
        reply: `${SELF_HEADER} Groq API key missing.`,
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
        reply: `${SELF_HEADER} No cached context available for this chat.`,
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
      reply: `${SELF_HEADER} Context Summary (${messages.length} messages):\n\n${aiReply}`,
      usedAI: true,
    };
  }

  // ── !!tldr [count] ────────────────────────────────────────────────────
  if (cmd === "tldr" || cmd.startsWith("tldr ")) {
    const countStr = raw.slice("tldr".length).trim();
    const count2 = parseInt(countStr || "20", 10);
    if (!groqApiKey) {
      return { reply: `${SELF_HEADER} Groq API key missing.`, usedAI: false };
    }
    const messages = await getRecentMessages(
      from,
      isNaN(count2) ? 20 : count2,
    );
    if (!messages.length) {
      return {
        reply: `${SELF_HEADER} No cached messages available.`,
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
    return { reply: `${SELF_HEADER}\n\n${aiReply}`, usedAI: true };
  }

  // ── !!tone (reply) ────────────────────────────────────────────────────
  if (cmd === "tone") {
    const quotedText = getQuotedText(msg);
    if (!quotedText) {
      return {
        reply: `${SELF_HEADER} Reply to a message with !!tone to detect its emotional tone.`,
        usedAI: false,
      };
    }
    if (!groqApiKey) {
      return { reply: `${SELF_HEADER} Groq API key missing.`, usedAI: false };
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
    return { reply: `${SELF_HEADER} Tone: ${aiReply.trim()}`, usedAI: true };
  }

  // ── !!find <keyword> ─────────────────────────────────────────────────
  if (cmd.startsWith("find ")) {
    const keyword = raw.slice("find ".length).trim().toLowerCase();
    if (!keyword) {
      return {
        reply: `${SELF_HEADER} Usage: !!find <keyword>`,
        usedAI: false,
      };
    }
    const messages = await getRecentMessages(from, 100);
    const matches = messages.filter((m) =>
      m.text.toLowerCase().includes(keyword),
    );
    if (!matches.length) {
      return {
        reply: `${SELF_HEADER} No messages found containing "${keyword}".`,
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
      reply: `${SELF_HEADER} Found ${matches.length} message(s) containing "${keyword}":\n\n${lines.join("\n")}`,
      usedAI: false,
    };
  }

  // ── !!voice <text> (or reply) ─────────────────────────────────────────
  if (cmd.startsWith("voice") && (cmd === "voice" || cmd.startsWith("voice "))) {
    const quotedText = getQuotedText(msg);
    const textToSpeak = quotedText || raw.slice("voice".length).trim();

    if (!textToSpeak) {
      return {
        reply: `${SELF_HEADER} Usage: !!voice <text> (or reply to a message)`,
        usedAI: false,
      };
    }
    if (!groqApiKey) {
      return {
        reply: `${SELF_HEADER} Groq API key missing for TTS.`,
        usedAI: false,
      };
    }

    const limitCheck = await checkVoiceLimit();
    if (!limitCheck.allowed) {
      return {
        reply: `${SELF_HEADER} Voice limit reached today (${limitCheck.count}/${SELF_RATE_LIMIT.voiceDailyLimit}). Resets at midnight IST.`,
        usedAI: false,
      };
    }

    const result = await generateVoiceMessage(textToSpeak, groqApiKey);
    if (!result.success || !result.audioBuffer) {
      return {
        reply: `${SELF_HEADER} Voice generation failed. Groq TTS may be temporarily unavailable.`,
        usedAI: false,
      };
    }

    try {
      await sock.sendMessage(from, {
        audio: result.audioBuffer,
        mimetype: "audio/mpeg",
        ptt: true,
      });
    } catch (err) {
      console.error("[SELF] Failed to send voice message:", err);
      return {
        reply: `${SELF_HEADER} Voice generated but failed to send.`,
        usedAI: false,
      };
    }
    return { reply: "", usedAI: false }; // audio already sent
  }

  // ── !!reply <style> (reply) ───────────────────────────────────────────
  if (cmd.startsWith("reply ")) {
    const style = raw.slice("reply ".length).trim().toLowerCase();
    const quotedText = getQuotedText(msg);
    if (!quotedText) {
      return {
        reply: `${SELF_HEADER} Reply to a message with !!reply <style>. Styles: formal, casual, decline, agree`,
        usedAI: false,
      };
    }
    if (!groqApiKey) {
      return { reply: `${SELF_HEADER} Groq API key missing.`, usedAI: false };
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
      reply: `${SELF_HEADER} Draft reply (${style}):\n${aiReply}`,
      usedAI: true,
    };
  }

  // ── !!search <query> ─────────────────────────────────────────────────
  if (cmd.startsWith("search ")) {
    const query = raw.slice("search ".length).trim();
    if (!query) {
      return {
        reply: `${SELF_HEADER} Usage: !!search <query>`,
        usedAI: false,
      };
    }
    const searchContext = await searchWeb(query);
    if (!groqApiKey) {
      return {
        reply: searchContext
          ? `${SELF_HEADER}\n\n${searchContext}`
          : `${SELF_HEADER} No results found for "${query}".`,
        usedAI: false,
      };
    }
    const systemWithSearch = searchContext
      ? `${SELF_SYSTEM_PROMPT}\n\nWeb search results:\n${searchContext}`
      : SELF_SYSTEM_PROMPT;
    const aiReply = await getGroqReply(
      [{ role: "user", content: query }],
      groqApiKey,
      GROQ_MODEL_SCOUT,
      systemWithSearch,
    );
    return { reply: `${SELF_HEADER}\n\n${aiReply}`, usedAI: true };
  }

  // ── General AI (with optional web search for current info) ───────────
  if (!groqApiKey) {
    return {
      reply: `${SELF_HEADER} Groq API key missing.`,
      usedAI: false,
    };
  }

  let systemPrompt = SELF_SYSTEM_PROMPT;
  let modelToUse = GROQ_MODEL_DEFAULT;

  if (requiresCurrentInfo(raw)) {
    const searchContext = await searchWeb(raw);
    if (searchContext) {
      systemPrompt = `${SELF_SYSTEM_PROMPT}\n\nReal-time web search results:\n${searchContext}`;
      modelToUse = GROQ_MODEL_SCOUT;
    }
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

  return { reply: `${SELF_HEADER}\n\n${aiReply}`, usedAI: true };
}
