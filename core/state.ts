import { redis } from "../storage/redisClient";

export interface UserSession {
  domainUnlocked: boolean;
  lastActiveAt: number;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  lastQuery?: { type: "mentors"; filter?: string; page: number };
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
  pendingCreateRole?: {
    roleName: string;
    step: "select_permissions";
    tries: number;
  };
  pendingDelete?: {
    mentorId: number;
    name: string;
  };
}

const AI_SESSION_TTL_SEC = 15 * 60; // 15 mins
const INTRO_TTL_SEC = 24 * 60 * 60; // 24 hours

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

// --- Pending Intros ---
export async function addPendingIntro(jid: string, groupJid: string): Promise<void> {
  await redis.setex(`pending_intro:${jid}`, INTRO_TTL_SEC, groupJid);
}

export async function getPendingIntro(jid: string): Promise<string | null> {
  return redis.get(`pending_intro:${jid}`);
}

export async function removePendingIntro(jid: string): Promise<void> {
  await redis.del(`pending_intro:${jid}`);
}

export async function getAllPendingIntros(): Promise<{ [jid: string]: string }> {
  // Use scan or keys. Given low cardinality, keys is okay but scan is safer.
  const keys = await redis.keys("pending_intro:*");
  if (!keys || keys.length === 0) return {};

  const intros: { [jid: string]: string } = {};
  const values = await redis.mget(...keys);
  for (let i = 0; i < keys.length; i++) {
    const jid = keys[i].replace("pending_intro:", "");
    if (values[i]) {
      intros[jid] = values[i] as string;
    }
  }
  return intros;
}
