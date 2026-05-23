import { getJidHash, logStructured } from "../utils/logger";

const AI_WINDOW_MS = 60 * 1000;
const AI_MAX_REQUESTS_PER_WINDOW = 5;
const AI_COOLDOWN_MS = 8 * 1000;

const MAX_GROUP_AI_RESPONSES_PER_HOUR = 100;
const MAX_GLOBAL_AI_RESPONSES_PER_DAY = 2000;
const BURST_WINDOW_MS = 10 * 1000;
const BURST_MAX_MESSAGES = 4;
const MUTE_DURATION_MS = 10 * 60 * 1000;

interface RateLimitState {
  windowStart: number;
  requestCount: number;
  lastRequestAt: number;
}

interface RateLimitCheck {
  allowed: boolean;
  reason?: string;
  retryAfterMs?: number;
}

interface RateLimitNotice {
  reason: string;
  notifiedAt: number;
}

interface GroupRateLimitState {
  hourlyCount: number;
  hourlyWindowStart: number;
  burstTimestamps: number[];
  mutedUntil: number;
}

interface GroupLimitCheck {
  allowed: boolean;
  reason?: "muted" | "hourly_limit" | "global_limit";
  retryAfterMs?: number;
}

const userAiRateLimits = new Map<string, RateLimitState>();
const userAiRateLimitNotices = new Map<string, RateLimitNotice>();
const groupRateLimitStates = new Map<string, GroupRateLimitState>();

export let globalDailyAiCount = 0;
export let globalCountResetTime = Date.now() + 24 * 60 * 60 * 1000;

export function incrementGlobalDailyAiCount(): void {
  globalDailyAiCount += 1;
}

function buildRateLimitKey(from: string, senderId: string): string {
  return `${from}:${senderId}`;
}

function getRateLimitState(key: string): RateLimitState {
  if (!userAiRateLimits.has(key)) {
    userAiRateLimits.set(key, {
      windowStart: Date.now(),
      requestCount: 0,
      lastRequestAt: 0,
    });
  }
  return userAiRateLimits.get(key)!;
}

export function checkAiRateLimit(from: string, senderId: string): RateLimitCheck {
  const now = Date.now();
  const key = buildRateLimitKey(from, senderId);
  const state = getRateLimitState(key);

  if (now - state.windowStart >= AI_WINDOW_MS) {
    state.windowStart = now;
    state.requestCount = 0;
  }

  const cooldownRemaining = AI_COOLDOWN_MS - (now - state.lastRequestAt);

  if (cooldownRemaining > 0) {
    return {
      allowed: false,
      reason: "cooldown",
      retryAfterMs: cooldownRemaining,
    };
  }

  if (state.requestCount >= AI_MAX_REQUESTS_PER_WINDOW) {
    return {
      allowed: false,
      reason: "window-limit",
      retryAfterMs: AI_WINDOW_MS - (now - state.windowStart),
    };
  }

  state.requestCount += 1;
  state.lastRequestAt = now;

  return {
    allowed: true,
  };
}

export function clearRateLimitNotice(from: string, senderId: string): void {
  const key = buildRateLimitKey(from, senderId);
  userAiRateLimitNotices.delete(key);
}

export function shouldSendRateLimitNotice(
  from: string,
  senderId: string,
  rateLimitCheck: RateLimitCheck,
): boolean {
  if (rateLimitCheck?.allowed) {
    clearRateLimitNotice(from, senderId);
    return false;
  }

  const key = buildRateLimitKey(from, senderId);
  const existing = userAiRateLimitNotices.get(key);
  const reason = rateLimitCheck?.reason || "unknown";

  if (existing?.reason === reason) {
    return false;
  }

  userAiRateLimitNotices.set(key, {
    reason,
    notifiedAt: Date.now(),
  });

  return true;
}

export function formatRetryAfter(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return `${seconds}s`;
}

function getGroupRateLimitState(groupJid: string): GroupRateLimitState {
  if (!groupRateLimitStates.has(groupJid)) {
    groupRateLimitStates.set(groupJid, {
      hourlyCount: 0,
      hourlyWindowStart: Date.now(),
      burstTimestamps: [],
      mutedUntil: 0,
    });
  }
  return groupRateLimitStates.get(groupJid)!;
}

export function checkGroupAndGlobalLimits(groupJid: string): GroupLimitCheck {
  const now = Date.now();
  
  if (now >= globalCountResetTime) {
    globalDailyAiCount = 0;
    globalCountResetTime = now + 24 * 60 * 60 * 1000;
  }
  if (globalDailyAiCount >= MAX_GLOBAL_AI_RESPONSES_PER_DAY) {
    return { allowed: false, reason: "global_limit" };
  }
  
  if (!groupJid.endsWith("@g.us")) {
    return { allowed: true };
  }
  
  const state = getGroupRateLimitState(groupJid);
  
  if (state.mutedUntil > now) {
    return { allowed: false, reason: "muted", retryAfterMs: state.mutedUntil - now };
  }
  
  if (now - state.hourlyWindowStart >= 60 * 60 * 1000) {
    state.hourlyWindowStart = now;
    state.hourlyCount = 0;
  }
  if (state.hourlyCount >= MAX_GROUP_AI_RESPONSES_PER_HOUR) {
    const remainingTime = 60 * 60 * 1000 - (now - state.hourlyWindowStart);
    return { allowed: false, reason: "hourly_limit", retryAfterMs: remainingTime };
  }
  
  state.burstTimestamps = state.burstTimestamps.filter(t => now - t < BURST_WINDOW_MS);
  state.burstTimestamps.push(now);
  
  if (state.burstTimestamps.length > BURST_MAX_MESSAGES) {
    state.mutedUntil = now + MUTE_DURATION_MS;
    logStructured({
      event: "group_muted",
      groupHash: getJidHash(groupJid),
      durationMs: MUTE_DURATION_MS,
    });
    return { allowed: false, reason: "muted", retryAfterMs: MUTE_DURATION_MS };
  }
  
  state.hourlyCount += 1;
  return { allowed: true };
}
