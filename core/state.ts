import { redis } from "../storage/redisClient";

export interface UserSession {
  domainUnlocked: boolean;
  lastActiveAt: number;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  lastQuery?: {
    type: "mentors" | "clubs" | "events" | "projects";
    filter?: string;
    page: number;
  };
  pendingMentor?: {
    name: string;
    organization: string;
    description?: string;
    expertise?: string;
    linkedin?: string;
    instagram?: string;
    github?: string;
    email?: string;
    phoneNoCountryCode: string;
  };
  pendingEdit?: {
    mentorId: number;
    flag: string;
    phoneNoCountryCode: string;
  };
  pendingDeleteGroup?: {
    id: number;
    jid: string;
    botNumber: number;
  };
  pendingDeleteChat?: {
    id: number;
    jid: string;
    botNumber: number;
  };
  pendingEditGroup?: {
    id: number;
    jid: string;
    botNumber: number;
  };
  pendingEditChat?: {
    id: number;
    jid: string;
    botNumber: number;
  };
  pendingDelete?: {
    mentorId: number;
    name: string;
  };
}

const AI_SESSION_TTL_SEC = 15 * 60; // 15 mins

// --- User Sessions ---
export async function getSession(sessionKey: string): Promise<UserSession> {
  const data = await redis.get(`session:${sessionKey}`);
  if (data) {
    try {
      return JSON.parse(data) as UserSession;
    } catch (e) {
      console.error(`Failed to parse session for ${sessionKey}`, e);
    }
  }
  return {
    domainUnlocked: false,
    lastActiveAt: 0,
    messages: [],
  };
}

export async function saveSession(sessionKey: string, session: UserSession): Promise<void> {
  await redis.setex(`session:${sessionKey}`, AI_SESSION_TTL_SEC, JSON.stringify(session));
}

// --- Last Sent / Last User Messages ---
export async function getLastSentMessage(to: string): Promise<string | null> {
  return redis.get(`last_sent:${to}`);
}

export async function setLastSentMessage(to: string, message: string): Promise<void> {
  await redis.setex(`last_sent:${to}`, AI_SESSION_TTL_SEC, message);
}

export async function getLastUserMessage(sessionKey: string): Promise<string | null> {
  return redis.get(`last_user_msg:${sessionKey}`);
}

export async function setLastUserMessage(sessionKey: string, message: string): Promise<void> {
  await redis.setex(`last_user_msg:${sessionKey}`, AI_SESSION_TTL_SEC, message);
}
