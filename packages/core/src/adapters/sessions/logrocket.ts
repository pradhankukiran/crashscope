import { z } from "zod";
import {
  AdapterError,
  AuthError,
  ValidationError,
  classifyHttpFailure,
} from "../../errors.js";
import type {
  FetchForUserOptions,
  SessionAdapter,
} from "../../types/adapters.js";
import type {
  NormalizedEvent,
  NormalizedEventType,
  NormalizedSession,
  PageView,
} from "../../types/session.js";

/**
 * LogRocket session adapter.
 *
 * @experimental
 * The LogRocket adapter has not been verified against a live LogRocket
 * account. Endpoint paths and filter syntax are inferred from public
 * documentation; the response-shape schemas are deliberately tolerant so
 * field drift does not crash normalization. Report bugs to
 * https://github.com/pradhankukiran/crashscope/issues.
 *
 * Resolves a single replay near an error timestamp for a given user and
 * projects it into {@link NormalizedSession}.
 *
 * Endpoint surface (per LogRocket's public REST API documentation):
 *   GET /v1/orgs/{orgSlug}/apps/{appSlug}/sessions
 *   GET /v1/orgs/{orgSlug}/apps/{appSlug}/sessions/{sessionId}
 *   GET /v1/orgs/{orgSlug}/apps/{appSlug}/sessions/{sessionId}/events
 *
 * The events endpoint is gated to higher plan tiers; we gracefully degrade
 * to "session metadata only" if it returns 404.
 *
 * Auth: `Authorization: Bearer {service-account-api-key}`.
 *
 * NOTE ON FILTER SYNTAX: LogRocket's session search documentation is sparse.
 * This adapter uses plain query parameters (`user_id`, `start_time`,
 * `end_time`, `limit`) which is the most plausible REST default. If your
 * LogRocket plan exposes a different filter convention (e.g. JSON:API
 * `filter[user][id]=…`), the search will return zero sessions and the
 * adapter will return `null` — verify against your project's API.
 */

interface LogRocketAdapterOptions {
  readonly apiKey: string;
  readonly orgSlug: string;
  readonly appSlug: string;
  readonly baseUrl?: string;
}

const PROVIDER = "logrocket" as const;
const DEFAULT_BASE_URL = "https://r.logrocket.io";
const DEFAULT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 300;
const SESSION_SEARCH_LIMIT = 10;
const EVENTS_FETCH_LIMIT = 200;

// ---------------------------------------------------------------------------
// LogRocket response schemas (tolerant — fields we depend on only).
// ---------------------------------------------------------------------------

const logRocketUserSchema = z
  .object({
    id: z.string().optional(),
    email: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

const logRocketSessionSummarySchema = z
  .object({
    id: z.string(),
    // LogRocket sometimes returns snake_case, sometimes camelCase — accept either.
    start_time: z.string().optional(),
    startTime: z.string().optional(),
    end_time: z.string().optional(),
    endTime: z.string().optional(),
    duration: z.number().optional(),
    duration_ms: z.number().optional(),
    durationMs: z.number().optional(),
    url: z.string().optional(),
    replay_url: z.string().optional(),
    replayUrl: z.string().optional(),
    user: logRocketUserSchema.optional(),
  })
  .passthrough();

const logRocketSearchResponseSchema = z
  .object({
    sessions: z.array(logRocketSessionSummarySchema).optional(),
    data: z.array(logRocketSessionSummarySchema).optional(),
    results: z.array(logRocketSessionSummarySchema).optional(),
  })
  .passthrough();

const logRocketSessionDetailSchema = logRocketSessionSummarySchema;

const logRocketEventSchema = z
  .object({
    // LogRocket uses several shapes; we accept whichever is present.
    type: z.string().optional(),
    event: z.string().optional(),
    kind: z.string().optional(),
    timestamp: z.union([z.string(), z.number()]).optional(),
    time: z.union([z.string(), z.number()]).optional(),
    target: z
      .union([
        z.string(),
        z
          .object({
            selector: z.string().optional(),
            text: z.string().optional(),
            tag: z.string().optional(),
          })
          .passthrough(),
      ])
      .optional(),
    selector: z.string().optional(),
    url: z.string().optional(),
    href: z.string().optional(),
  })
  .passthrough();

const logRocketEventsResponseSchema = z
  .object({
    events: z.array(logRocketEventSchema).optional(),
    data: z.array(logRocketEventSchema).optional(),
    results: z.array(logRocketEventSchema).optional(),
  })
  .passthrough();

type LogRocketSessionSummary = z.infer<typeof logRocketSessionSummarySchema>;
type LogRocketEvent = z.infer<typeof logRocketEventSchema>;
type LogRocketEventsResponse = z.infer<typeof logRocketEventsResponseSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredBackoff(attempt: number): number {
  const exp = BASE_BACKOFF_MS * 2 ** attempt;
  return exp + Math.floor(Math.random() * BASE_BACKOFF_MS);
}

function toIso(value: string | number | undefined): string | null {
  if (value === undefined) return null;
  const date =
    typeof value === "number"
      ? new Date(value > 1e12 ? value : value * 1000)
      : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function pickStartTime(session: LogRocketSessionSummary): string | null {
  return toIso(session.start_time ?? session.startTime);
}

function pickEndTime(session: LogRocketSessionSummary): string | null {
  return toIso(session.end_time ?? session.endTime);
}

function pickDurationMs(session: LogRocketSessionSummary): number {
  const direct = session.duration ?? session.duration_ms ?? session.durationMs;
  if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) {
    return Math.floor(direct);
  }
  const start = pickStartTime(session);
  const end = pickEndTime(session);
  if (start && end) {
    const diff = new Date(end).getTime() - new Date(start).getTime();
    if (Number.isFinite(diff) && diff >= 0) return diff;
  }
  return 0;
}

function pickUserId(session: LogRocketSessionSummary, fallback: string): string {
  return session.user?.id ?? session.user?.email ?? fallback;
}

function normalizeEventType(raw: string | undefined): NormalizedEventType {
  const lc = (raw ?? "").toLowerCase();
  switch (lc) {
    case "click":
      return "click";
    case "input":
      return "input";
    case "navigation":
    case "page":
    case "page_view":
    case "pageview":
      return "navigation";
    case "error":
      return "error";
    default:
      return "other";
  }
}

function extractTarget(event: LogRocketEvent): string | null {
  if (typeof event.target === "string") return event.target;
  if (event.target && typeof event.target === "object") {
    const t = event.target;
    return t.selector ?? t.text ?? t.tag ?? null;
  }
  if (typeof event.selector === "string") return event.selector;
  return null;
}

function extractUrl(event: LogRocketEvent): string | null {
  return event.url ?? event.href ?? null;
}

/**
 * Mark consecutive click events on the same target as rage clicks when each
 * adjacent pair fires within 1s of the previous one.
 *
 * The "adjacent" check (rather than measuring against the run's first click)
 * matches how real rage-click gestures decay: a user spamming a button for
 * three seconds is still ragey even though the last click is more than 1s
 * after the first. We promote the *entire* run (not just trailing clicks) so
 * the triage LLM doesn't see a misleading mix of click + rage_click for the
 * same UI gesture.
 */
function markRageClicks(events: NormalizedEvent[]): NormalizedEvent[] {
  const result = events.slice();
  let runStart = 0;
  while (runStart < result.length) {
    const current = result[runStart];
    if (!current || current.type !== "click" || current.target === null) {
      runStart += 1;
      continue;
    }
    let runEnd = runStart;
    while (runEnd + 1 < result.length) {
      const prev = result[runEnd];
      const next = result[runEnd + 1];
      if (
        !prev ||
        !next ||
        next.type !== "click" ||
        next.target !== current.target
      ) {
        break;
      }
      const adjacentMs =
        new Date(next.timestamp).getTime() -
        new Date(prev.timestamp).getTime();
      if (adjacentMs > 1000) break;
      runEnd += 1;
    }
    if (runEnd - runStart >= 1) {
      // 2+ clicks on same target with no gap >1s — promote run to rage_click.
      for (let i = runStart; i <= runEnd; i += 1) {
        const ev = result[i];
        if (ev) result[i] = { ...ev, type: "rage_click" };
      }
    }
    runStart = runEnd + 1;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class LogRocketAdapter implements SessionAdapter {
  public readonly name = PROVIDER;

  private readonly apiKey: string;
  private readonly orgSlug: string;
  private readonly appSlug: string;
  private readonly baseUrl: string;
  /**
   * Tracks whether we've already emitted the "this adapter is experimental"
   * warning for this instance. Per-instance (not module-static) so multiple
   * adapters in the same process still each warn once if instantiated.
   */
  private hasWarned = false;

  public constructor(opts: LogRocketAdapterOptions) {
    if (!opts.apiKey) {
      throw new AdapterError(
        PROVIDER,
        "apiKey is required to construct LogRocketAdapter",
      );
    }
    if (!opts.orgSlug) {
      throw new AdapterError(
        PROVIDER,
        "orgSlug is required to construct LogRocketAdapter",
      );
    }
    if (!opts.appSlug) {
      throw new AdapterError(
        PROVIDER,
        "appSlug is required to construct LogRocketAdapter",
      );
    }
    this.apiKey = opts.apiKey;
    this.orgSlug = opts.orgSlug;
    this.appSlug = opts.appSlug;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  public async fetchForUser(
    opts: FetchForUserOptions,
  ): Promise<NormalizedSession | null> {
    if (!this.hasWarned) {
      this.hasWarned = true;
      // Use console.warn rather than throwing — the adapter is callable and
      // probably works on common plans, but the maintainers haven't verified
      // it against a live LogRocket account so callers should treat session
      // contents as best-effort until they confirm against their project.
      console.warn(
        `[${PROVIDER}] adapter is experimental — endpoint paths and filter syntax are inferred from public docs. Verify against your own LogRocket project before relying on it.`,
      );
    }
    const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    const startTime = new Date(opts.around.getTime() - windowMs).toISOString();
    const endTime = new Date(opts.around.getTime() + windowMs).toISOString();

    // Filter syntax: plain query params are the most plausible REST default
    // for LogRocket's Sessions API. If your plan requires JSON:API style
    // (`filter[user][id]=…`), the search will return zero sessions and this
    // method returns `null`.
    const search = new URLSearchParams({
      user_id: opts.userId,
      start_time: startTime,
      end_time: endTime,
      limit: String(SESSION_SEARCH_LIMIT),
    });

    const sessionsRoot = this.sessionsRootPath();
    const searchPath = `${sessionsRoot}?${search.toString()}`;
    const searchResponse = await this.logrocketGet(
      searchPath,
      logRocketSearchResponseSchema,
    );

    const sessions =
      searchResponse.sessions ??
      searchResponse.data ??
      searchResponse.results ??
      [];
    if (sessions.length === 0) return null;

    const closest = pickClosest(sessions, opts.around);
    if (!closest) return null;

    // Hydrate detail + events. Detail may already have everything we need;
    // events is a separate endpoint and gated to higher plan tiers.
    const detailPath = `${sessionsRoot}/${encodeURIComponent(closest.id)}`;
    const eventsPath = `${detailPath}/events?limit=${EVENTS_FETCH_LIMIT}`;

    const [detail, eventsResponse] = await Promise.all([
      this.logrocketGet(detailPath, logRocketSessionDetailSchema).catch(
        (err: unknown) => {
          // Detail unavailable shouldn't kill normalization; the summary from
          // search carries enough fields to continue. 404 specifically means
          // the session id we picked is no longer addressable — degrade
          // rather than error.
          if (
            err instanceof AdapterError &&
            err.message.includes("404")
          ) {
            return closest;
          }
          throw err;
        },
      ),
      this.logrocketGet(eventsPath, logRocketEventsResponseSchema).catch(
        (err: unknown) => {
          // The per-session events endpoint is gated to higher LogRocket plan
          // tiers. A 404 here typically means "your plan doesn't expose this
          // resource" rather than "this session has no events". Degrade
          // silently: return the session with metadata + replay URL only so
          // the agent loop still has something to work with.
          if (
            err instanceof AdapterError &&
            err.message.includes("404")
          ) {
            const empty: LogRocketEventsResponse = { events: [] };
            return empty;
          }
          throw err;
        },
      ),
    ]);

    const rawEvents =
      eventsResponse.events ??
      eventsResponse.data ??
      eventsResponse.results ??
      [];

    const events = normalizeEvents(rawEvents);
    const pageViews: PageView[] = events
      .filter((e) => e.type === "navigation")
      .map((e) => {
        const url =
          typeof e.properties["url"] === "string" ? e.properties["url"] : null;
        return url === null ? null : { url, timestamp: e.timestamp };
      })
      .filter((p): p is PageView => p !== null);

    const startedAt = pickStartTime(detail) ?? opts.around.toISOString();
    const durationMs = pickDurationMs(detail);
    const userId = pickUserId(detail, opts.userId);
    // Prefer the URL LogRocket returns on the session object; fall back to
    // our canonical builder for plans that don't surface it.
    const replayUrl =
      detail.url ??
      detail.replay_url ??
      detail.replayUrl ??
      this.replayUrl(closest.id);

    return {
      id: closest.id,
      provider: PROVIDER,
      userId,
      startedAt,
      durationMs,
      replayUrl,
      events,
      pageViews,
      raw: { session: detail, events: rawEvents },
    };
  }

  public replayUrl(sessionId: string): string | null {
    if (!sessionId) return null;
    return `https://app.logrocket.com/${encodeURIComponent(this.orgSlug)}/${encodeURIComponent(this.appSlug)}/sessions/${encodeURIComponent(sessionId)}`;
  }

  private sessionsRootPath(): string {
    return `/v1/orgs/${encodeURIComponent(this.orgSlug)}/apps/${encodeURIComponent(this.appSlug)}/sessions`;
  }

  /**
   * GET helper with retry on 429/5xx, Zod validation, and consistent error
   * classification:
   *   - 401 → AuthError ("check your API key")
   *   - 403 → AuthError ("your plan may not include this API")
   *   - 404 → non-retryable AdapterError surfaced verbatim so callers can
   *           probe alternates or degrade gracefully
   *   - 429/5xx → retryable AdapterError, retried with jittered backoff
   */
  private async logrocketGet<T>(
    path: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: "application/json",
          },
        });
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES - 1) {
          await sleep(jitteredBackoff(attempt));
          continue;
        }
        throw new AdapterError(
          PROVIDER,
          `network error calling ${url}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err, retryable: true },
        );
      }

      const status = response.status;

      if (status === 401) {
        throw new AuthError(
          PROVIDER,
          "unauthorized — check your LogRocket service account API key",
        );
      }
      if (status === 403) {
        throw new AuthError(
          PROVIDER,
          "forbidden — your LogRocket plan may not include the Sessions API. Confirm the Service Account has API access on a plan that exposes session endpoints.",
        );
      }
      if (status === 404) {
        const body = await safeReadText(response);
        throw new AdapterError(
          PROVIDER,
          `404 not found at ${url}${body ? `: ${body}` : ""}`,
        );
      }
      if (status === 429 || (status >= 500 && status <= 599)) {
        const body = await safeReadText(response);
        const classified = classifyHttpFailure(
          PROVIDER,
          status,
          `${url}${body ? `: ${body}` : ""}`,
        );
        lastError = classified;
        if (attempt < MAX_RETRIES - 1) {
          await sleep(jitteredBackoff(attempt));
          continue;
        }
        throw classified;
      }
      if (!response.ok) {
        const body = await safeReadText(response);
        throw classifyHttpFailure(
          PROVIDER,
          status,
          `${url}${body ? `: ${body}` : ""}`,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (err) {
        throw new AdapterError(
          PROVIDER,
          `failed to parse JSON from ${url}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }

      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        throw new ValidationError(
          `LogRocket response at ${path} did not match expected shape`,
          parsed.error,
        );
      }
      return parsed.data;
    }

    // Loop exits only via return/throw; this is defensive.
    if (lastError instanceof AuthError || lastError instanceof AdapterError) {
      throw lastError;
    }
    throw new AdapterError(
      PROVIDER,
      `exhausted retries calling ${url}`,
      {
        retryable: true,
        ...(lastError === null ? {} : { cause: lastError }),
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Pure helpers exposed at module scope for testability.
// ---------------------------------------------------------------------------

/**
 * Choose the session whose `[start, end]` interval is closest to `around`.
 * Distance is 0 when the anchor falls inside the interval, otherwise the
 * gap to the nearest endpoint. Mirrors `pickClosestRecording` in the PostHog
 * adapter so triage anchoring behaves consistently across providers.
 */
function pickClosest(
  sessions: LogRocketSessionSummary[],
  around: Date,
): LogRocketSessionSummary | null {
  const target = around.getTime();
  let best: LogRocketSessionSummary | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const s of sessions) {
    const startIso = pickStartTime(s);
    if (!startIso) continue;
    const startMs = new Date(startIso).getTime();
    const endIso = pickEndTime(s);
    const endMs = endIso ? new Date(endIso).getTime() : startMs;
    const distance =
      target < startMs
        ? startMs - target
        : target > endMs
          ? target - endMs
          : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = s;
    }
  }
  return best;
}

function normalizeEvents(raw: LogRocketEvent[]): NormalizedEvent[] {
  const normalized: NormalizedEvent[] = [];
  for (const ev of raw) {
    const rawType = ev.type ?? ev.event ?? ev.kind;
    const type = normalizeEventType(rawType);
    const tsRaw = ev.timestamp ?? ev.time;
    const timestamp = toIso(tsRaw);
    if (timestamp === null) continue; // Drop events with no timestamp — nothing we can anchor on.
    const target = extractTarget(ev);
    const url = extractUrl(ev);
    const properties: Record<string, unknown> = { ...ev };
    if (url !== null && properties["url"] === undefined) {
      properties["url"] = url;
    }
    if (rawType !== undefined && properties["rawType"] === undefined) {
      properties["rawType"] = rawType;
    }
    normalized.push({
      timestamp,
      type,
      target,
      properties,
    });
  }
  normalized.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  return markRageClicks(normalized);
}

async function safeReadText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return "";
  }
}
