/**
 * Rate limiting for `POST /api/triage` — the public demo endpoint.
 *
 * The endpoint runs Claude on a visitor's behalf using credentials the visitor
 * supplies, but the visitor's *traffic* still flows through our IP, our
 * Sentry/PostHog adapter calls hit upstream from our network, and a single
 * leaked Anthropic key + our URL is a recipe for someone else's bill draining
 * very fast. So: per-IP caps.
 *
 * Two tracks:
 *   1. **Production** — Upstash REST Redis + `@upstash/ratelimit` sliding
 *      windows. Configure with `UPSTASH_REDIS_REST_URL` +
 *      `UPSTASH_REDIS_REST_TOKEN`.
 *   2. **Fallback** — a process-local `Map<ip, timestamps>` limiter. Good
 *      enough for `next dev` and single-instance deploys, but useless behind
 *      a load balancer with N instances. Logged loudly at first use so
 *      operators notice.
 *
 * Limits: 3 requests / IP / hour, 20 requests / IP / day. Both windows are
 * checked; the more restrictive verdict wins, and the response returns the
 * tighter `Retry-After` of the two.
 */
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

/** Per-hour quota (sliding window). */
export const HOURLY_LIMIT = 3;
/** Per-day quota (sliding window). */
export const DAILY_LIMIT = 20;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface RateLimitVerdict {
  /** True if the request should be allowed through. */
  allowed: boolean;
  /** Seconds the client should wait before retrying. Always present when `allowed === false`. */
  retryAfterSec: number;
  /** Which window tripped first, for diagnostics / log lines. */
  reason: "hour" | "day" | "ok";
}

/* ---------------------------------------------------------------------------
 * In-memory fallback limiter
 *
 * Two ring buffers per IP — one for the hourly window, one for the daily one.
 * Stale entries are pruned on touch; we also cap the buffers' growth so a
 * single noisy IP cannot OOM the process.
 * ------------------------------------------------------------------------- */

interface IpBucket {
  /** Timestamps (ms) of the last `<HOURLY_LIMIT * 2>` accepted requests. */
  hour: number[];
  /** Timestamps (ms) of the last `<DAILY_LIMIT * 2>` accepted requests. */
  day: number[];
}

const memoryStore = new Map<string, IpBucket>();
let warnedAboutFallback = false;

function pruneAndCount(buf: number[], windowMs: number, now: number): number {
  let i = 0;
  while (i < buf.length && now - buf[i]! > windowMs) i += 1;
  if (i > 0) buf.splice(0, i);
  return buf.length;
}

function checkInMemory(ip: string): RateLimitVerdict {
  if (!warnedAboutFallback) {
    warnedAboutFallback = true;
    console.warn(
      "[rate-limit] using in-memory fallback — single-instance only. " +
        "For proper rate limiting, set UPSTASH_REDIS_REST_URL and " +
        "UPSTASH_REDIS_REST_TOKEN.",
    );
  }
  const now = Date.now();
  const bucket = memoryStore.get(ip) ?? { hour: [], day: [] };
  const hourCount = pruneAndCount(bucket.hour, HOUR_MS, now);
  const dayCount = pruneAndCount(bucket.day, DAY_MS, now);

  if (hourCount >= HOURLY_LIMIT) {
    const oldest = bucket.hour[0] ?? now;
    const retryAfterSec = Math.max(1, Math.ceil((HOUR_MS - (now - oldest)) / 1000));
    memoryStore.set(ip, bucket);
    return { allowed: false, retryAfterSec, reason: "hour" };
  }
  if (dayCount >= DAILY_LIMIT) {
    const oldest = bucket.day[0] ?? now;
    const retryAfterSec = Math.max(1, Math.ceil((DAY_MS - (now - oldest)) / 1000));
    memoryStore.set(ip, bucket);
    return { allowed: false, retryAfterSec, reason: "day" };
  }

  bucket.hour.push(now);
  bucket.day.push(now);
  // Cap buffer growth so a busy IP can't grow these unboundedly.
  if (bucket.hour.length > HOURLY_LIMIT * 4) bucket.hour.splice(0, bucket.hour.length - HOURLY_LIMIT * 4);
  if (bucket.day.length > DAILY_LIMIT * 4) bucket.day.splice(0, bucket.day.length - DAILY_LIMIT * 4);
  memoryStore.set(ip, bucket);
  return { allowed: true, retryAfterSec: 0, reason: "ok" };
}

/* ---------------------------------------------------------------------------
 * Upstash-backed limiter
 *
 * Two `Ratelimit` instances share a single Redis client. The library uses a
 * sliding-window algorithm by default which is closer to what users expect
 * than fixed windows ("3 per hour" really meaning 3 per hour, not 0-6 in the
 * worst case at a window boundary).
 * ------------------------------------------------------------------------- */

interface UpstashLimiter {
  hour: Ratelimit;
  day: Ratelimit;
}

let cachedUpstash: UpstashLimiter | null | undefined;

function getUpstashLimiter(): UpstashLimiter | null {
  if (cachedUpstash !== undefined) return cachedUpstash;
  const url = process.env["UPSTASH_REDIS_REST_URL"];
  const token = process.env["UPSTASH_REDIS_REST_TOKEN"];
  if (!url || !token) {
    cachedUpstash = null;
    return cachedUpstash;
  }
  const redis = new Redis({ url, token });
  cachedUpstash = {
    hour: new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(HOURLY_LIMIT, "1 h"),
      prefix: "crashscope:triage:post:hour",
      analytics: false,
    }),
    day: new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(DAILY_LIMIT, "24 h"),
      prefix: "crashscope:triage:post:day",
      analytics: false,
    }),
  };
  return cachedUpstash;
}

async function checkUpstash(
  limiter: UpstashLimiter,
  ip: string,
): Promise<RateLimitVerdict> {
  const [hourRes, dayRes] = await Promise.all([
    limiter.hour.limit(ip),
    limiter.day.limit(ip),
  ]);
  if (!hourRes.success) {
    const retryAfterSec = Math.max(1, Math.ceil((hourRes.reset - Date.now()) / 1000));
    return { allowed: false, retryAfterSec, reason: "hour" };
  }
  if (!dayRes.success) {
    const retryAfterSec = Math.max(1, Math.ceil((dayRes.reset - Date.now()) / 1000));
    return { allowed: false, retryAfterSec, reason: "day" };
  }
  return { allowed: true, retryAfterSec: 0, reason: "ok" };
}

/**
 * Check whether the supplied IP is currently allowed to call
 * `POST /api/triage`. Side-effect: records the attempt on success (both
 * tracks).
 *
 * Errors from Upstash are *not* swallowed silently — we log them and
 * fail-open. Failing closed would mean a Redis outage takes our public demo
 * offline, which is worse than letting a few requests slip through while the
 * provider recovers.
 */
export async function checkPostTriageLimit(ip: string): Promise<RateLimitVerdict> {
  const upstash = getUpstashLimiter();
  if (upstash) {
    try {
      return await checkUpstash(upstash, ip);
    } catch (err: unknown) {
      console.error("[rate-limit] upstash check failed, falling open", err);
      // Fall through to memory limiter so we still apply *some* cap rather
      // than letting the request through unbounded.
      return checkInMemory(ip);
    }
  }
  return checkInMemory(ip);
}

/**
 * Test-only escape hatch — clear the in-memory store + Upstash client cache.
 * Production code should never call this.
 */
export function __resetRateLimitForTests(): void {
  memoryStore.clear();
  cachedUpstash = undefined;
  warnedAboutFallback = false;
}
