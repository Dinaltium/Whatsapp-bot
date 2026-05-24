import { getJidHash, logStructured } from "../utils/logger";
import { redis } from "../storage/redisClient";

const AI_WINDOW_MS = 60 * 1000;
const AI_MAX_REQUESTS_PER_WINDOW = 5;
const AI_COOLDOWN_MS = 8 * 1000;

const MAX_GROUP_AI_RESPONSES_PER_HOUR = 100;
const MAX_GLOBAL_AI_RESPONSES_PER_DAY = 2000;
const BURST_WINDOW_MS = 10 * 1000;
const BURST_MAX_MESSAGES = 4;
const MUTE_DURATION_MS = 10 * 60 * 1000;

export interface RateLimitState {
  windowStart: number;
  requestCount: number;
  lastRequestAt: number;
  bannedUntil?: number;
  banCount?: number;
  consecutiveViolations?: number;
}

export interface RateLimitCheck {
  allowed: boolean;
  reason?: string;
  retryAfterMs?: number;
}

export interface GroupRateLimitState {
  hourlyCount: number;
  hourlyWindowStart: number;
  burstTimestamps: number[];
  mutedUntil: number;
}

export interface GroupLimitCheck {
  allowed: boolean;
  reason?: "muted" | "hourly_limit" | "global_limit";
  retryAfterMs?: number;
}

function buildRateLimitKey(from: string, senderId: string): string {
  return `rate_limit:${from}:${senderId}`;
}

async function getRateLimitState(key: string): Promise<RateLimitState> {
  const data = await redis.get(key);
  if (data) {
    try {
      return JSON.parse(data) as RateLimitState;
    } catch (e) {
      console.error(`Error parsing rate limit for ${key}`, e);
    }
  }
  return {
    windowStart: Date.now(),
    requestCount: 0,
    lastRequestAt: 0,
    consecutiveViolations: 0,
    banCount: 0,
  };
}

async function saveRateLimitState(key: string, state: RateLimitState): Promise<void> {
  // Store up to 2 hours for active states to auto-prune
  await redis.setex(key, 2 * 60 * 60, JSON.stringify(state));
}

export async function incrementGlobalDailyAiCount(): Promise<void> {
  const now = new Date();
  const dateKey = `global_ai_count:${now.toISOString().split("T")[0]}`;
  const count = await redis.incr(dateKey);
  if (count === 1) {
    // Expire tomorrow to prevent bloat
    await redis.expire(dateKey, 24 * 60 * 60 * 2);
  }
}

export async function getGlobalDailyAiCount(): Promise<number> {
  const now = new Date();
  const dateKey = `global_ai_count:${now.toISOString().split("T")[0]}`;
  const count = await redis.get(dateKey);
  return count ? parseInt(count, 10) : 0;
}

export async function checkAiRateLimit(from: string, senderId: string): Promise<RateLimitCheck> {
  const now = Date.now();
  const key = buildRateLimitKey(from, senderId);
  const state = await getRateLimitState(key);

  if (state.bannedUntil && state.bannedUntil > now) {
    return {
      allowed: false,
      reason: "banned",
      retryAfterMs: state.bannedUntil - now,
    };
  }

  if (now - state.windowStart >= AI_WINDOW_MS) {
    state.windowStart = now;
    state.requestCount = 0;
  }

  const cooldownRemaining = AI_COOLDOWN_MS - (now - state.lastRequestAt);

  if (cooldownRemaining > 0) {
    state.consecutiveViolations = (state.consecutiveViolations || 0) + 1;
    state.lastRequestAt = now; // update to prolong cooldown penalty
    
    if (state.consecutiveViolations >= 3) {
      const banCount = (state.banCount || 0) + 1;
      state.banCount = banCount;
      const banDuration = 5 * 60 * 1000 * Math.pow(2, banCount - 1); // 5m, 10m, 20m...
      state.bannedUntil = now + banDuration;
      state.consecutiveViolations = 0;
      await saveRateLimitState(key, state);
      return {
        allowed: false,
        reason: "banned-trigger",
        retryAfterMs: banDuration,
      };
    }

    await saveRateLimitState(key, state);
    return {
      allowed: false,
      reason: "cooldown",
      retryAfterMs: cooldownRemaining,
    };
  }

  if (state.requestCount >= AI_MAX_REQUESTS_PER_WINDOW) {
    state.consecutiveViolations = (state.consecutiveViolations || 0) + 1;
    state.lastRequestAt = now;

    if (state.consecutiveViolations >= 3) {
      const banCount = (state.banCount || 0) + 1;
      state.banCount = banCount;
      const banDuration = 5 * 60 * 1000 * Math.pow(2, banCount - 1);
      state.bannedUntil = now + banDuration;
      state.consecutiveViolations = 0;
      await saveRateLimitState(key, state);
      return {
        allowed: false,
        reason: "banned-trigger",
        retryAfterMs: banDuration,
      };
    }

    await saveRateLimitState(key, state);
    return {
      allowed: false,
      reason: "window-limit",
      retryAfterMs: AI_WINDOW_MS - (now - state.windowStart),
    };
  }

  state.consecutiveViolations = 0;
  state.requestCount += 1;
  state.lastRequestAt = now;
  await saveRateLimitState(key, state);

  return {
    allowed: true,
  };
}

export async function clearRateLimitNotice(from: string, senderId: string): Promise<void> {
  const key = `rate_limit_notice:${from}:${senderId}`;
  await redis.del(key);
}

export async function shouldSendRateLimitNotice(
  from: string,
  senderId: string,
  rateLimitCheck: RateLimitCheck,
): Promise<boolean> {
  if (rateLimitCheck?.allowed) {
    await clearRateLimitNotice(from, senderId);
    return false;
  }

  const key = `rate_limit_notice:${from}:${senderId}`;
  const existingData = await redis.get(key);
  const reason = rateLimitCheck?.reason || "unknown";

  if (existingData) {
    const existing = JSON.parse(existingData);
    if (existing.reason === reason) {
      return false;
    }
  }

  await redis.setex(key, 2 * 60 * 60, JSON.stringify({ reason, notifiedAt: Date.now() }));
  return true;
}

export function formatRetryAfter(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return `${seconds}s`;
}

async function getGroupRateLimitState(groupJid: string): Promise<GroupRateLimitState> {
  const key = `group_rate_limit:${groupJid}`;
  const data = await redis.get(key);
  if (data) {
    try {
      return JSON.parse(data) as GroupRateLimitState;
    } catch (e) {
      console.error(`Error parsing group limit for ${key}`, e);
    }
  }
  return {
    hourlyCount: 0,
    hourlyWindowStart: Date.now(),
    burstTimestamps: [],
    mutedUntil: 0,
  };
}

async function saveGroupRateLimitState(groupJid: string, state: GroupRateLimitState): Promise<void> {
  const key = `group_rate_limit:${groupJid}`;
  await redis.setex(key, 2 * 60 * 60, JSON.stringify(state));
}

export async function checkGroupAndGlobalLimits(groupJid: string): Promise<GroupLimitCheck> {
  const now = Date.now();
  
  const globalCount = await getGlobalDailyAiCount();
  if (globalCount >= MAX_GLOBAL_AI_RESPONSES_PER_DAY) {
    return { allowed: false, reason: "global_limit" };
  }
  
  if (!groupJid.endsWith("@g.us")) {
    return { allowed: true };
  }
  
  const state = await getGroupRateLimitState(groupJid);
  
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
    await saveGroupRateLimitState(groupJid, state);
    logStructured({
      event: "group_muted",
      groupHash: getJidHash(groupJid),
      durationMs: MUTE_DURATION_MS,
    });
    return { allowed: false, reason: "muted", retryAfterMs: MUTE_DURATION_MS };
  }
  
  state.hourlyCount += 1;
  await saveGroupRateLimitState(groupJid, state);
  return { allowed: true };
}
