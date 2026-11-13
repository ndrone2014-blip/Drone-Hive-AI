import { getEnv, getEnvInt } from '../env.js';
import { AIError, ERROR_CODES } from '../ai/errors.js';
import { getFirestoreConfig, incrementDocs, readDoc } from './firestore.js';

/**
 * Usage limits — the "token protection system". Everything is enforced HERE,
 * on the server. Nothing in the browser can change or skip it: refreshing,
 * new sessions, private windows or other browsers all count against the same
 * signed-in account (and the same IP address).
 *
 * Limits (all configurable with environment variables, see .env.example):
 *   per minute   AI_RATE_LIMIT_PER_MINUTE      (burst protection, per edge server)
 *   per hour     AI_HOURLY_REQUESTS_PER_USER
 *   per day      AI_DAILY_REQUESTS_PER_USER (100), AI_DAILY_TOKENS_PER_USER (25,000)
 *   per week     AI_WEEKLY_TOKENS_PER_USER (100,000)   — week starts Monday 00:00 UTC
 *   per month    AI_MONTHLY_TOKENS_PER_USER (300,000)  — month starts on the 1st, 00:00 UTC
 *   everyone     AI_GLOBAL_DAILY_REQUESTS, AI_GLOBAL_DAILY_TOKENS
 *   kill switch  AI_EMERGENCY_STOP=true   (or emergencyStop in Firestore, no redeploy needed)
 *   in flight    max AI_MAX_CONCURRENT_PER_USER replies at once; identical
 *                messages that are already being answered are refused.
 *
 * Storage:
 *   - Firestore (free Spark plan) when a service account is configured:
 *     counters are shared by every Netlify edge server and survive restarts.
 *   - Otherwise in memory: still enforced, but per edge server and reset when
 *     it restarts. The README explains how to turn Firestore on.
 *   Day = UTC calendar day. Hour = UTC clock hour. Week = Monday–Sunday (UTC).
 *   Month = UTC calendar month.
 *
 * Every provider (Gemini, Vibe AI/Mistral, OpenRouter, Groq, Ollama, …) and
 * every mode (Automatic, Default, a chosen provider) counts against the SAME
 * counters, which are keyed by account and IP only — never by provider — so
 * switching AIs can't reset or dodge a limit.
 *
 * Firestore also holds an optional admin document `config/limits` that you
 * can edit in the Firebase console to change limits or pause the AI instantly:
 *   emergencyStop (bool), globalDailyRequests, globalDailyTokens,
 *   dailyRequestsPerUser, dailyTokensPerUser, weeklyTokensPerUser,
 *   monthlyTokensPerUser, hourlyRequestsPerUser (numbers)
 */

const MINUTE = 60_000;
const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function getLimitConfig(overrides = {}) {
  const pick = (k, v) => (Number.isFinite(overrides[k]) && overrides[k] > 0 ? overrides[k] : v);
  return {
    perMinute: getEnvInt('AI_RATE_LIMIT_PER_MINUTE', { min: 1, max: 600, fallback: 6 }),
    perHour: pick('hourlyRequestsPerUser', getEnvInt('AI_HOURLY_REQUESTS_PER_USER', { min: 1, max: 100000, fallback: 30 })),
    perDay: pick('dailyRequestsPerUser', getEnvInt('AI_DAILY_REQUESTS_PER_USER', { min: 1, max: 100000, fallback: 100 })),
    tokensPerDay: pick('dailyTokensPerUser', getEnvInt('AI_DAILY_TOKENS_PER_USER', { min: 1000, max: 100_000_000, fallback: 25_000 })),
    tokensPerWeek: pick('weeklyTokensPerUser', getEnvInt('AI_WEEKLY_TOKENS_PER_USER', { min: 1000, max: 1_000_000_000, fallback: 100_000 })),
    tokensPerMonth: pick('monthlyTokensPerUser', getEnvInt('AI_MONTHLY_TOKENS_PER_USER', { min: 1000, max: 1_000_000_000, fallback: 300_000 })),
    globalPerDay: pick('globalDailyRequests', getEnvInt('AI_GLOBAL_DAILY_REQUESTS', { min: 1, max: 10_000_000, fallback: 1500 })),
    globalTokensPerDay: pick('globalDailyTokens', getEnvInt('AI_GLOBAL_DAILY_TOKENS', { min: 1000, max: 10_000_000_000, fallback: 3_000_000 })),
    maxConcurrent: getEnvInt('AI_MAX_CONCURRENT_PER_USER', { min: 1, max: 20, fallback: 2 }),
    emergencyStop: getEnv('AI_EMERGENCY_STOP', 'false') === 'true' || overrides.emergencyStop === true,
  };
}

// ── Time helpers (UTC) ───────────────────────────────────────────────────────
const dayId = (now) => new Date(now).toISOString().slice(0, 10);
const hourField = (now) => `h${new Date(now).toISOString().slice(11, 13)}`;
const nextDay = (now) => Math.floor(now / DAY) * DAY + DAY;
const nextHour = (now) => Math.floor(now / HOUR) * HOUR + HOUR;
/** Start of the current week (Monday 00:00 UTC), in ms. */
const weekStart = (now) => {
  const dayStart = Math.floor(now / DAY) * DAY;
  const dow = (new Date(dayStart).getUTCDay() + 6) % 7; // Monday = 0
  return dayStart - dow * DAY;
};
const weekId = (now) => new Date(weekStart(now)).toISOString().slice(0, 10); // e.g. 2026-11-09
const nextWeek = (now) => weekStart(now) + 7 * DAY;
const monthId = (now) => new Date(now).toISOString().slice(0, 7); // e.g. 2026-11
const nextMonth = (now) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
};
const fmtWhen = (ms) => new Date(ms).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

async function hashKey(key) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`dhai:${key}`));
  return [...new Uint8Array(d).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── In-memory state (per edge server) ────────────────────────────────────────
const MAX_TRACKED = 20000;
const memory = new Map(); // key -> { day, requests, tokens, hours: {hNN: n}, minute: [], week, weekTokens, month, monthTokens }
const inFlight = new Map(); // key -> count
const inFlightMessages = new Set(); // key|fingerprint
let adminCache = { at: 0, value: {} };

export function _resetUsageState() {
  memory.clear();
  inFlight.clear();
  inFlightMessages.clear();
  adminCache = { at: 0, value: {} };
}

function memEntry(key, now) {
  let v = memory.get(key);
  if (!v) {
    if (memory.size >= MAX_TRACKED) memory.delete(memory.keys().next().value);
    v = { day: dayId(now), requests: 0, tokens: 0, hours: {}, minute: [], week: weekId(now), weekTokens: 0, month: monthId(now), monthTokens: 0 };
    memory.set(key, v);
  }
  if (v.day !== dayId(now)) Object.assign(v, { day: dayId(now), requests: 0, tokens: 0, hours: {} });
  if (v.week !== weekId(now)) Object.assign(v, { week: weekId(now), weekTokens: 0 });
  if (v.month !== monthId(now)) Object.assign(v, { month: monthId(now), monthTokens: 0 });
  v.minute = v.minute.filter((t) => now - t < MINUTE);
  return v;
}

/** Admin overrides from Firestore `config/limits`, cached for 30 seconds. */
async function getAdminOverrides(fs, now) {
  if (!fs) return {};
  if (now - adminCache.at < 30_000) return adminCache.value;
  try {
    adminCache = { at: now, value: (await readDoc(fs, 'config/limits')) || {} };
  } catch (err) {
    console.warn(`[drone-hive-ai] Could not read admin limits: ${err.message}`);
    adminCache = { at: now, value: adminCache.value };
  }
  return adminCache.value;
}

// ── Errors (professional, user-facing) ───────────────────────────────────────
function limitError(code, message, resetAt, now) {
  return new AIError(code, message, code === ERROR_CODES.SERVICE_PAUSED ? 503 : 429, undefined, {
    'retry-after': String(Math.max(1, Math.ceil((resetAt - now) / 1000))),
  }).with({ resetAt: new Date(resetAt).toISOString() });
}

function check(counts, cfg, scale, now) {
  if (counts.hour > cfg.perHour * scale) {
    return limitError(ERROR_CODES.USAGE_LIMIT, `You’ve reached the hourly limit of ${plural(cfg.perHour * scale, 'message')}. You can send more after the hour resets.`, nextHour(now), now);
  }
  if (counts.requests > cfg.perDay * scale) {
    return limitError(ERROR_CODES.USAGE_LIMIT, `You’ve reached your daily limit of ${plural(cfg.perDay * scale, 'message')}. Your usage resets every day at midnight UTC.`, nextDay(now), now);
  }
  if (counts.monthTokens >= cfg.tokensPerMonth * scale) {
    return limitError(ERROR_CODES.USAGE_LIMIT, `You’ve used this month’s AI allowance of ${plural(cfg.tokensPerMonth * scale, 'token')}. It resets on ${fmtWhen(nextMonth(now))} at midnight UTC.`, nextMonth(now), now);
  }
  if (counts.weekTokens >= cfg.tokensPerWeek * scale) {
    return limitError(ERROR_CODES.USAGE_LIMIT, `You’ve used this week’s AI allowance of ${plural(cfg.tokensPerWeek * scale, 'token')}. It resets every Monday at midnight UTC.`, nextWeek(now), now);
  }
  if (counts.tokens >= cfg.tokensPerDay * scale) {
    return limitError(ERROR_CODES.USAGE_LIMIT, `You’ve used today’s AI allowance of ${plural(cfg.tokensPerDay * scale, 'token')}. Your usage resets every day at midnight UTC.`, nextDay(now), now);
  }
  return null;
}

/**
 * Call at the start of every chat request. Throws a friendly AIError if any
 * limit is hit. Returns a ticket:
 *   ticket.budget      tokens this request may still use (min over all limits)
 *   ticket.quota       usage summary for the browser
 *   ticket.finish(n)   record the tokens actually used and release the slot
 *
 * keys: [{ key: 'user:abc', scale: 1 }, { key: 'ip:1.2.3.4', scale: 3 }]
 * fingerprint: identifies the message, to refuse duplicate submissions.
 */
export async function beginUsage(keys, { now = Date.now(), fingerprint = '' } = {}) {
  const fs = getFirestoreConfig();
  const admin = await getAdminOverrides(fs, now);
  const cfg = getLimitConfig(admin);

  if (cfg.emergencyStop) {
    throw limitError(ERROR_CODES.SERVICE_PAUSED, 'Drone Hive AI is temporarily paused for maintenance. Please check back soon.', now + 15 * MINUTE, now);
  }

  // 1. Burst + concurrency + duplicate checks (instant, in memory).
  for (const { key, scale } of keys) {
    const v = memEntry(key, now);
    if (v.minute.length >= cfg.perMinute * scale) {
      throw new AIError(ERROR_CODES.RATE_LIMITED, `Slow down — you can send ${plural(cfg.perMinute * scale, 'message')} per minute. Try again in a moment.`, 429, undefined, {
        'retry-after': String(Math.max(1, Math.ceil((MINUTE - (now - v.minute[0])) / 1000))),
      });
    }
  }
  const primary = keys[0].key;
  if ((inFlight.get(primary) || 0) >= cfg.maxConcurrent) {
    throw new AIError(ERROR_CODES.RATE_LIMITED, 'Please wait for your current reply to finish before sending another message.', 429, undefined, { 'retry-after': '5' });
  }
  const dupKey = fingerprint ? `${primary}|${fingerprint}` : '';
  if (dupKey && inFlightMessages.has(dupKey)) {
    throw new AIError(ERROR_CODES.DUPLICATE_REQUEST, 'That message is already being answered.', 409);
  }
  for (const { key } of keys) memEntry(key, now).minute.push(now);

  // 2. Persistent counters: add this request, then check the new totals.
  const day = dayId(now);
  const week = weekId(now);
  const month = monthId(now);
  const hour = hourField(now);
  let counts; // [{ requests, hour, tokens, weekTokens, monthTokens }] per key, then global last
  let store = 'memory';
  if (fs) {
    try {
      const hashed = await Promise.all(keys.map((k) => hashKey(k.key)));
      const expireAt = new Date(nextDay(now) + 2 * DAY);
      const weekExpire = new Date(nextWeek(now) + 2 * DAY);
      const monthExpire = new Date(nextMonth(now) + 2 * DAY);
      const results = await incrementDocs(fs, [
        ...hashed.map((h) => ({ path: `usage/${day}__${h}`, add: { requests: 1, [hour]: 1, tokens: 0 }, expireAt })),
        { path: `usage/${day}__global`, add: { requests: 1, tokens: 0 }, expireAt },
        // Weekly and monthly token totals (read here by adding 0).
        ...hashed.map((h) => ({ path: `usage/w${week}__${h}`, add: { tokens: 0 }, expireAt: weekExpire })),
        ...hashed.map((h) => ({ path: `usage/m${month}__${h}`, add: { tokens: 0 }, expireAt: monthExpire })),
      ]);
      const n = keys.length;
      counts = results.slice(0, n + 1).map((r, i) => ({
        requests: r.requests,
        hour: r[hour] || 0,
        tokens: r.tokens,
        weekTokens: i < n ? results[n + 1 + i]?.tokens || 0 : 0,
        monthTokens: i < n ? results[2 * n + 1 + i]?.tokens || 0 : 0,
      }));
      store = 'firestore';
    } catch (err) {
      console.warn(`[drone-hive-ai] Usage store unavailable, using in-memory limits: ${err.message}`);
    }
  }
  if (!counts) {
    counts = keys.map(({ key }) => {
      const v = memEntry(key, now);
      v.requests += 1;
      v.hours[hour] = (v.hours[hour] || 0) + 1;
      return { requests: v.requests, hour: v.hours[hour], tokens: v.tokens, weekTokens: v.weekTokens, monthTokens: v.monthTokens };
    });
    const g = memEntry('__global__', now);
    g.requests += 1;
    counts.push({ requests: g.requests, hour: 0, tokens: g.tokens, weekTokens: 0, monthTokens: 0 });
  }

  const global = counts[counts.length - 1];
  if (global.requests > cfg.globalPerDay || global.tokens >= cfg.globalTokensPerDay) {
    throw limitError(ERROR_CODES.GLOBAL_LIMIT, 'Drone Hive AI has reached its daily capacity. New messages will work again after the daily reset at midnight UTC.', nextDay(now), now);
  }
  for (let i = 0; i < keys.length; i++) {
    const err = check(counts[i], cfg, keys[i].scale, now);
    if (err) throw err;
  }

  // 3. Reserve a slot.
  inFlight.set(primary, (inFlight.get(primary) || 0) + 1);
  if (dupKey) inFlightMessages.add(dupKey);

  // Tokens still allowed for this request: the smallest of what's left today,
  // this week and this month (for every key), and of the global daily cap.
  const room = [
    { left: cfg.globalTokensPerDay - global.tokens, resetAt: nextDay(now), period: 'day' },
    ...keys.flatMap((k, i) => [
      { left: cfg.tokensPerDay * k.scale - counts[i].tokens, resetAt: nextDay(now), period: 'day' },
      { left: cfg.tokensPerWeek * k.scale - counts[i].weekTokens, resetAt: nextWeek(now), period: 'week' },
      { left: cfg.tokensPerMonth * k.scale - counts[i].monthTokens, resetAt: nextMonth(now), period: 'month' },
    ]),
  ].sort((x, y) => x.left - y.left || y.resetAt - x.resetAt)[0];
  const budget = Math.max(0, room.left);
  const mine = counts[0];
  let finished = false;
  return {
    store,
    budget,
    // Which allowance is closest to running out, and when it resets.
    budgetPeriod: room.period,
    budgetResetAt: new Date(room.resetAt).toISOString(),
    quota: {
      requestsUsed: mine.requests,
      requestsLimit: cfg.perDay * keys[0].scale,
      hourUsed: mine.hour,
      hourLimit: cfg.perHour * keys[0].scale,
      tokensUsed: mine.tokens,
      tokensLimit: cfg.tokensPerDay * keys[0].scale,
      resetAt: new Date(nextDay(now)).toISOString(),
      weekTokensUsed: mine.weekTokens,
      weekTokensLimit: cfg.tokensPerWeek * keys[0].scale,
      weekResetAt: new Date(nextWeek(now)).toISOString(),
      monthTokensUsed: mine.monthTokens,
      monthTokensLimit: cfg.tokensPerMonth * keys[0].scale,
      monthResetAt: new Date(nextMonth(now)).toISOString(),
    },
    /**
     * Records the tokens used and frees the slot. With { refund: true } (no AI
     * could answer at all) the message isn't counted against the hourly/daily
     * allowance. The per-minute burst limit still counts it.
     */
    async finish(tokens, { refund = false } = {}) {
      if (finished) return;
      finished = true;
      const n = Math.max(0, Math.ceil(Number(tokens) || 0));
      inFlight.set(primary, Math.max(0, (inFlight.get(primary) || 1) - 1));
      if (!inFlight.get(primary)) inFlight.delete(primary);
      if (dupKey) inFlightMessages.delete(dupKey);
      this.quota.tokensUsed += n;
      this.quota.weekTokensUsed += n;
      this.quota.monthTokensUsed += n;
      if (refund) {
        this.quota.requestsUsed = Math.max(0, this.quota.requestsUsed - 1);
        this.quota.hourUsed = Math.max(0, this.quota.hourUsed - 1);
      }
      if (!n && !refund) return;
      const keyAdd = refund ? { requests: -1, [hour]: -1, tokens: n } : { tokens: n };
      const globalAdd = refund ? { requests: -1, tokens: n } : { tokens: n };
      if (store === 'firestore') {
        try {
          const hashed = await Promise.all(keys.map((k) => hashKey(k.key)));
          await incrementDocs(fs, [
            ...hashed.map((h) => ({ path: `usage/${day}__${h}`, add: keyAdd })),
            { path: `usage/${day}__global`, add: globalAdd },
            ...(n ? hashed.flatMap((h) => [
              { path: `usage/w${week}__${h}`, add: { tokens: n } },
              { path: `usage/m${month}__${h}`, add: { tokens: n } },
            ]) : []),
          ]);
          return;
        } catch (err) {
          console.warn(`[drone-hive-ai] Could not record usage: ${err.message}`);
          return;
        }
      }
      // Add to the counters of the periods this request started in. (Reading
      // them with the current clock would reset them if a period rolled over
      // while the reply was being written.)
      for (const { key } of keys) {
        const v = memory.get(key) || memEntry(key, now);
        if (v.day === day) v.tokens += n;
        if (v.week === week) v.weekTokens += n;
        if (v.month === month) v.monthTokens += n;
        if (refund && v.day === day) {
          v.requests = Math.max(0, v.requests - 1);
          v.hours[hour] = Math.max(0, (v.hours[hour] || 1) - 1);
        }
      }
      const g = memory.get('__global__') || memEntry('__global__', now);
      if (g.day === day) g.tokens += n;
      if (refund && g.day === day) g.requests = Math.max(0, g.requests - 1);
    },
  };
}

/** Whether limits are stored persistently (for the admin-only startup log). */
export function usageStoreName() {
  return getFirestoreConfig() ? 'firestore' : 'memory';
}
