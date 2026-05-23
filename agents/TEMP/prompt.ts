import { TEMP_SYSTEM_PROMPT } from "./intro";
import { getGroqReply as getGroqReplyClient } from "../../ai/groqClient";

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export async function getGroqReply(
  conversationMessages: ConversationMessage[],
  groqApiKey: string | undefined,
  groqModel: string,
): Promise<string> {
  return getGroqReplyClient(conversationMessages, groqApiKey, groqModel, TEMP_SYSTEM_PROMPT);
}
