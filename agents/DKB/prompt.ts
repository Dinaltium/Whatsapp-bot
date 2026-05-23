import { DK24_SYSTEM_PROMPT } from "./intro";
import { getGroqReply as getGroqReplyClient } from "../../ai/groqClient";
import { buildDynamicContextPrompt } from "../../ai/promptBuilder";

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export async function getGroqReply(
  conversationMessages: ConversationMessage[],
  groqApiKey: string | undefined,
  groqModel: string,
  userPrompt: string,
): Promise<string> {
  const dynamicContext = await buildDynamicContextPrompt(userPrompt);
  const systemPrompt = `${DK24_SYSTEM_PROMPT}\n\n${dynamicContext}`;

  return getGroqReplyClient(conversationMessages, groqApiKey, groqModel, systemPrompt);
}
