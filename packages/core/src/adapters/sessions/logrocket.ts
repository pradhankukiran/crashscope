import { z } from "zod";
import { AdapterError, AuthError, ValidationError } from "../../errors.js";
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
 * Resolves a single replay near an error timestamp for a given user and
 * projects it into {@link NormalizedSession}.
 *
 * IMPORTANT CAVEAT: LogRocket's public REST API is sparsely documented and
 * some endpoints are gated to higher plan tiers. The endpoint shapes used
 * here are best-effort and tolerant: every schema uses `.passthrough()` and
 * only fields we depend on are validated. Specifically the following may
 * drift from production:
 *   - The search path. We first try `/v1/apps/{appSlug}/sessions/search`
 *     and fall back to `/v1/orgs/{appSlug}/apps/{appSlug}/sessions/search`
 *     if the first returns 404 — we don't know the org slug independently,
 *     so the appSlug is reused as a best-effort.
 *   - Event type strings (LogRocket uses "click" / "input" / "navigation" /
 *     "error" / "console" / "network" / "redux", but variants like
 *     "page_view" or "page" may also appear).
 *   - `replay_url` is preferred when LogRocket returns it on the session
 *     object; otherwise we construct the canonical app.logrocket.com link.
 */

interface LogRocketAdapterOptions {
  readonly apiKey: string;
  readonly appSlug: string;
  readonly baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://r.logrocket.io";
const FALLBACK_BASE_URL = "https://api.logrocket.com";
const DEFAULT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 300;

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

function isRetriableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
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
 * Mark sequences of >=2 click events within 1s on the same target as rage clicks.
 *
 * We mutate the *type* of the entire run (not just trailing clicks) so the
 * triage LLM doesn't see a misleading mix of click + rage_click on the same
 * UI gesture.
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
    const startMs = new Date(current.timestamp).getTime();
    while (runEnd + 1 < result.length) {
      const next = result[runEnd + 1];
      if (!next || next.type !== "click" || next.target !== current.target) {
        break;
      }
      const nextMs = new Date(next.timestamp).getTime();
      if (nextMs - startMs > 1000) break;
      runEnd += 1;
    }
    if (runEnd - runStart >= 1) {
      // 2+ clicks within 1s on same target — promote whole run to rage_click.
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
  public readonly name = "logrocket";

  private readonly apiKey: string;
  private readonly appSlug: string;
  private readonly baseUrl: string;

  public constructor(opts: LogRocketAdapterOptions) {
    if (!opts.apiKey) {
      throw new AdapterError(
        "logrocket",
        "apiKey is required to construct LogRocketAdapter",
      );
    }
    if (!opts.appSlug) {
      throw new AdapterError(
        "logrocket",
        "appSlug is required to construct LogRocketAdapter",
      );
    }
    this.apiKey = opts.apiKey;
    this.appSlug = opts.appSlug;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  public async fetchForUser(
    opts: FetchForUserOptions,
  ): Promise<NormalizedSession | null> {
    const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    const startTime = new Date(opts.around.getTime() - windowMs).toISOString();
    const endTime = new Date(opts.around.getTime() + windowMs).toISOString();

    const search = new URLSearchParams({
      userId: opts.userId,
      startTime,
      endTime,
      limit: "10",
    });

    // Path probing: primary is app-scoped; fall back to org-scoped if the
    // first hop returns 404 (we don't have an org slug, so reuse appSlug).
    const candidatePaths = [
      `/v1/apps/${encodeURIComponent(this.appSlug)}/sessions/search?${search.toString()}`,
      `/v1/orgs/${encodeURIComponent(this.appSlug)}/apps/${encodeURIComponent(this.appSlug)}/sessions/search?${search.toString()}`,
    ];

    let searchResponse: z.infer<typeof logRocketSearchResponseSchema> | null = null;
    let lastNotFoundPath = "";
    for (const path of candidatePaths) {
      try {
        searchResponse = await this.logrocketGet(
          path,
          logRocketSearchResponseSchema,
        );
        break;
      } catch (err) {
        if (err instanceof AdapterError && err.message.includes("404")) {
          lastNotFoundPath = path;
          continue;
        }
        throw err;
      }
    }

    if (searchResponse === null) {
      throw new AdapterError(
        "logrocket",
        `session search endpoint not found (tried ${candidatePaths.length} paths; last: ${lastNotFoundPath})`,
      );
    }

    const sessions =
      searchResponse.sessions ??
      searchResponse.data ??
      searchResponse.results ??
      [];
    if (sessions.length === 0) return null;

    const closest = pickClosest(sessions, opts.around);
    if (!closest) return null;

    // Hydrate detail + events. Detail may already have everything we need;
    // events is a separate endpoint.
    const detailPath = `/v1/apps/${encodeURIComponent(this.appSlug)}/sessions/${encodeURIComponent(closest.id)}`;
    const eventsPath = `${detailPath}/events?limit=200`;

    const [detail, eventsResponse] = await Promise.all([
      this.logrocketGet(detailPath, logRocketSessionDetailSchema).catch(
        (err: unknown) => {
          // Detail being unavailable shouldn't kill the normalization; we
          // can fall back to the summary from search.
          if (err instanceof AdapterError && err.message.includes("404")) {
            return closest;
          }
          throw err;
        },
      ),
      this.logrocketGet(eventsPath, logRocketEventsResponseSchema).catch(
        (err: unknown) => {
          if (err instanceof AdapterError && err.message.includes("404")) {
            const empty: z.infer<typeof logRocketEventsResponseSchema> = {
              events: [],
            };
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
    const replayUrl =
      detail.replay_url ?? detail.replayUrl ?? this.replayUrl(closest.id);

    return {
      id: closest.id,
      provider: "logrocket",
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
    return `https://app.logrocket.com/${encodeURIComponent(this.appSlug)}/sessions/${encodeURIComponent(sessionId)}`;
  }

  /**
   * GET helper with retry on 429/5xx and Zod validation.
   *
   * Falls over to the secondary host (`api.logrocket.com`) once if the primary
   * returns a network-level error or 5xx after retries are exhausted, because
   * LogRocket's docs reference both hosts for different endpoints.
   */
  private async logrocketGet<T>(
    path: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    try {
      return await this.attemptGet(this.baseUrl, path, schema);
    } catch (err) {
      if (this.baseUrl === DEFAULT_BASE_URL && err instanceof AdapterError) {
        // Try secondary host once on persistent failure for hot-path endpoints.
        try {
          return await this.attemptGet(FALLBACK_BASE_URL, path, schema);
        } catch {
          throw err;
        }
      }
      throw err;
    }
  }

  private async attemptGet<T>(
    host: string,
    path: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const url = `${host}${path}`;
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
          "logrocket",
          `network error calling ${url}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }

      if (response.status === 401) {
        throw new AuthError(
          "logrocket",
          "unauthorized — check your LogRocket service account API key",
        );
      }
      if (response.status === 403) {
        throw new AdapterError(
          "logrocket",
          "403 forbidden — your LogRocket plan may not include the Sessions/Search API. Confirm the Service Account has API access on a plan that exposes session endpoints.",
        );
      }
      if (response.status === 404) {
        // Surface 404 cleanly so the caller can probe alternate paths.
        const body = await safeReadText(response);
        throw new AdapterError(
          "logrocket",
          `404 not found at ${url}${body ? `: ${body}` : ""}`,
        );
      }
      if (isRetriableStatus(response.status)) {
        lastError = new AdapterError(
          "logrocket",
          `${response.status} from ${url}`,
        );
        if (attempt < MAX_RETRIES - 1) {
          await sleep(jitteredBackoff(attempt));
          continue;
        }
        throw lastError;
      }
      if (!response.ok) {
        const body = await safeReadText(response);
        throw new AdapterError(
          "logrocket",
          `${response.status} from ${url}${body ? `: ${body}` : ""}`,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (err) {
        throw new AdapterError(
          "logrocket",
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
    throw new AdapterError(
      "logrocket",
      `exhausted retries calling ${url}`,
      lastError === null ? undefined : { cause: lastError },
    );
  }
}

// ---------------------------------------------------------------------------
// Pure helpers exposed at module scope for testability.
// ---------------------------------------------------------------------------

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
    const distance = Math.abs(new Date(startIso).getTime() - target);
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
