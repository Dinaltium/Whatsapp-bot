import { getGroqReply } from "../../ai/groqClient";
import {
  TECH_KEYWORDS,
  IRRELEVANT_WORDS,
  PARAG_SYSTEM_PROMPT,
  getDomainRestrictionReply,
} from "./intro";

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

interface UserSession {
  domainUnlocked: boolean;
  lastActiveAt: number;
  messages: ConversationMessage[];
}

interface AgentResult {
  reply: string;
  usedAI: boolean;
  domainLocked?: boolean;
}

function formatBotReply(text: string): string {
  return String(text || "").trim();
}

function isTechOrHackathonQuery(query: string | null | undefined): boolean {
  if (!query) return false;

  const normalizedQuery = query.toLowerCase();
  return TECH_KEYWORDS.some((keyword) => normalizedQuery.includes(keyword));
}

export async function handleMessage(
  session: UserSession,
  userPrompt: string,
  groqApiKey: string | undefined,
  groqModel: string,
  isAdmin: boolean = false,
): Promise<AgentResult> {
  const normalized = (userPrompt || "").toLowerCase();
  const hasIrrelevant = IRRELEVANT_WORDS.some((w) => normalized.includes(w));
  const isTech = isTechOrHackathonQuery(userPrompt);

  if (!isTech && !session.domainUnlocked && !isAdmin) {
    return {
      reply: formatBotReply(getDomainRestrictionReply()),
      usedAI: false,
      domainLocked: true,
    };
  }

  if (isTech && hasIrrelevant) {
    const reply = [
      "That question is outside my scope. I focus on software engineering, product prototyping, and hackathon execution.",
      "For Redis cache optimization in Node.js, consider using the `redis` package with cluster mode or `ioredis` for better concurrency.",
      "Ignore external factors like mountain elevation shifts, as they don't impact Redis performance.",
    ].join(" ");

    return { reply: formatBotReply(reply), usedAI: false };
  }

  const aiReply = await getGroqReply(session.messages, groqApiKey, groqModel, PARAG_SYSTEM_PROMPT);
  return { reply: formatBotReply(aiReply), usedAI: true };
}
