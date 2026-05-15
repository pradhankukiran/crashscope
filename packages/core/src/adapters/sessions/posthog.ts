import { z } from "zod";
import { AdapterError, ValidationError } from "../../errors.js";
import {
  normalizedSessionSchema,
  type NormalizedEvent,
  type NormalizedEventType,
  type NormalizedSession,
  type PageView,
} from "../../types/session.js";
import type {
  FetchForUserOptions,
  SessionAdapter,
} from "../../types/adapters.js";

/* ------------------------------------------------------------------------- */
/* Constants                                                                  */
/* ------------------------------------------------------------------------- */

const PROVIDER = "posthog" as const;
const DEFAULT_HOST = "https://app.posthog.com";
const DEFAULT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 300;
const EVENT_FETCH_LIMIT = 200;
const RECORDING_FETCH_LIMIT = 10;

/* ------------------------------------------------------------------------- */
/* Zod schemas for PostHog API responses                                      */
/* ------------------------------------------------------------------------- */

/**
 * Minimal shape we read from the recording list endpoint. `.passthrough()` is
 * used so we don't break when PostHog adds fields.
 */
const recordingListItemSchema = z
  .object({
    id: z.string(),
    distinct_id: z.string().nullish(),
    start_time: z.string(),
    end_time: z.string().nullish(),
    duration: z.number().nullish(),
  })
  .passthrough();

const recordingListResponseSchema = z
  .object({
    results: z.array(recordingListItemSchema),
  })
  .passthrough();

const recordingDetailSchema = z
  .object({
    id: z.string(),
    distinct_id: z.string().nullish(),
    start_time: z.string(),
    end_time: z.string().nullish(),
    duration: z.number().nullish(),
  })
  .passthrough();

/**
 * Person event entry. `properties` is an open record because PostHog event
 * shapes are highly variable per integration.
 */
const personEventSchema = z
  .object({
    event: z.string(),
    timestamp: z.string(),
    properties: z.record(z.string(), z.unknown()).nullish(),
  })
  .passthrough();

const personEventsResponseSchema = z
  .object({
    results: z.array(personEventSchema),
  })
  .passthrough();

type RecordingListItem = z.infer<typeof recordingListItemSchema>;
type PersonEvent = z.infer<typeof personEventSchema>;

/* ------------------------------------------------------------------------- */
/* Adapter options                                                            */
/* ------------------------------------------------------------------------- */

export interface PostHogAdapterOptions {
  /** Personal API key (`phx_…`). Sent as `Authorization: Bearer …`. */
  apiKey: string;
  /** Numeric project id (string form). */
  projectId: string;
  /** Override the API base. Defaults to `https://app.posthog.com`. */
  host?: string;
}

/* ------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* ------------------------------------------------------------------------- */

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Strip trailing slashes and protocol from a host. Used to compute the
 * web origin for `replayUrl` while still letting the API call live under the
 * configured host.
 */
function stripProtocol(host: string): string {
  return host.replace(/^https?:\/\//i, "").replace(/\/+$/g, "");
}

/* ------------------------------------------------------------------------- */
/* PostHog adapter                                                            */
/* ------------------------------------------------------------------------- */

/**
 * Resolves a PostHog session recording near an error timestamp and projects
 * it into the provider-agnostic {@link NormalizedSession} shape.
 *
 * The expensive snapshot endpoint is intentionally avoided — the structured
 * person-events feed is sufficient for triage and orders of magnitude cheaper
 * to fetch.
 */
export class PostHogAdapter implements SessionAdapter {
  public readonly name = PROVIDER;

  private readonly apiKey: string;
  private readonly projectId: string;
  private readonly host: string;

  public constructor(opts: PostHogAdapterOptions) {
    if (!opts.apiKey) {
      throw new AdapterError(PROVIDER, "apiKey is required");
    }
    if (!opts.projectId) {
      throw new AdapterError(PROVIDER, "projectId is required");
    }
    this.apiKey = opts.apiKey;
    this.projectId = opts.projectId;
    this.host = (opts.host ?? DEFAULT_HOST).replace(/\/+$/g, "");
  }

  /** Find the recording closest to `around`, then enrich with person events. */
  public async fetchForUser(
    opts: FetchForUserOptions,
  ): Promise<NormalizedSession | null> {
    const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    const half = Math.max(0, Math.floor(windowMs / 2));
    const anchor = opts.around.getTime();
    const dateFrom = new Date(anchor - half).toISOString();
    const dateTo = new Date(anchor + half).toISOString();

    const listPath =
      `/api/projects/${encodeURIComponent(this.projectId)}` +
      `/session_recordings/` +
      `?person_id=${encodeURIComponent(opts.userId)}` +
      `&date_from=${encodeURIComponent(dateFrom)}` +
      `&date_to=${encodeURIComponent(dateTo)}` +
      `&limit=${RECORDING_FETCH_LIMIT}`;

    const list = await this.posthogGet(listPath, recordingListResponseSchema);
    const pick = pickClosestRecording(list.results, anchor);
    if (!pick) {
      return null;
    }

    const detailPath =
      `/api/projects/${encodeURIComponent(this.projectId)}` +
      `/session_recordings/${encodeURIComponent(pick.id)}`;
    const detail = await this.posthogGet(detailPath, recordingDetailSchema);

    const distinctId = detail.distinct_id ?? pick.distinct_id ?? opts.userId;
    const startedAtIso = normalizeIso(detail.start_time);
    const endedAtIso = detail.end_time ? normalizeIso(detail.end_time) : null;
    const durationMs = computeDurationMs(
      detail.duration ?? pick.duration ?? null,
      startedAtIso,
      endedAtIso,
    );

    // Person events: bounded by the recording window when available, otherwise
    // by the search window the caller asked for.
    const eventsFrom = startedAtIso;
    const eventsTo =
      endedAtIso ??
      new Date(new Date(startedAtIso).getTime() + durationMs).toISOString();

    const eventsPath =
      `/api/projects/${encodeURIComponent(this.projectId)}/events/` +
      `?distinct_id=${encodeURIComponent(distinctId)}` +
      `&after=${encodeURIComponent(eventsFrom)}` +
      `&before=${encodeURIComponent(eventsTo)}` +
      `&limit=${EVENT_FETCH_LIMIT}`;

    const eventsResponse = await this.posthogGet(
      eventsPath,
      personEventsResponseSchema,
    );

    const events = eventsResponse.results
      .map(mapPersonEvent)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const pageViews = buildPageViews(eventsResponse.results);

    const session: NormalizedSession = {
      id: detail.id,
      provider: PROVIDER,
      userId: distinctId,
      startedAt: startedAtIso,
      durationMs,
      replayUrl: this.replayUrl(detail.id),
      events,
      pageViews,
      raw: { recording: detail, events: eventsResponse.results },
    };

    return this.validate(session);
  }

  /**
   * Deep link into the PostHog replay UI. Uses the configured host so
   * self-hosted instances resolve correctly.
   */
  public replayUrl(sessionId: string): string | null {
    if (!sessionId) {
      return null;
    }
    const origin = stripProtocol(this.host) || stripProtocol(DEFAULT_HOST);
    return `https://${origin}/project/${encodeURIComponent(
      this.projectId,
    )}/replay/${encodeURIComponent(sessionId)}`;
  }

  /* ----------------------------------------------------------------------- */
  /* Private                                                                  */
  /* ----------------------------------------------------------------------- */

  /**
   * GET + retry + parse. Retries on 429 and 5xx with exponential backoff and
   * full jitter, gives up after {@link MAX_RETRIES} attempts.
   */
  private async posthogGet<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const url = `${this.host}${path}`;
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
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
        // Network-level failure — treat as retryable.
        lastError = err;
        if (attempt < MAX_RETRIES - 1) {
          await sleep(backoffDelayMs(attempt, undefined));
          continue;
        }
        throw new AdapterError(
          PROVIDER,
          `network error calling GET ${path}`,
          { cause: err },
        );
      }

      if (response.ok) {
        const json: unknown = await response.json().catch((err: unknown) => {
          throw new AdapterError(
            PROVIDER,
            `failed to parse JSON from GET ${path}`,
            { cause: err },
          );
        });
        const parsed = schema.safeParse(json);
        if (!parsed.success) {
          throw new ValidationError(
            `[${PROVIDER}] unexpected response shape for GET ${path}`,
            parsed.error,
          );
        }
        return parsed.data;
      }

      const retryable = response.status === 429 || response.status >= 500;
      const bodyText = await response.text().catch(() => "");
      lastError = new Error(
        `HTTP ${response.status} from GET ${path}: ${truncate(bodyText, 200)}`,
      );

      if (!retryable || attempt >= MAX_RETRIES - 1) {
        throw new AdapterError(
          PROVIDER,
          `request failed (${response.status}) for GET ${path}: ${truncate(
            bodyText,
            200,
          )}`,
          { cause: lastError },
        );
      }

      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      await sleep(backoffDelayMs(attempt, retryAfter));
    }

    throw new AdapterError(
      PROVIDER,
      `exhausted retries for GET ${path}`,
      lastError !== undefined ? { cause: lastError } : undefined,
    );
  }

  /** Final Zod check so we never emit a session that violates the contract. */
  private validate(session: NormalizedSession): NormalizedSession {
    const parsed = normalizedSessionSchema.safeParse(session);
    if (!parsed.success) {
      throw new ValidationError(
        `[${PROVIDER}] normalized session failed schema validation`,
        parsed.error,
      );
    }
    return parsed.data;
  }
}

/* ------------------------------------------------------------------------- */
/* Pure helpers (exported only for testing concerns — kept module-private)    */
/* ------------------------------------------------------------------------- */

/**
 * Choose the recording whose `start_time` is nearest to the anchor. Ties go
 * to the earlier recording. Returns `null` for an empty list.
 */
function pickClosestRecording(
  recordings: RecordingListItem[],
  anchorMs: number,
): RecordingListItem | null {
  let best: RecordingListItem | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const rec of recordings) {
    const startMs = Date.parse(rec.start_time);
    if (Number.isNaN(startMs)) {
      continue;
    }
    const endMs = rec.end_time ? Date.parse(rec.end_time) : startMs;
    // Distance to the interval [start, end]: 0 if the anchor falls inside.
    const delta =
      anchorMs < startMs
        ? startMs - anchorMs
        : anchorMs > endMs
          ? anchorMs - endMs
          : 0;
    if (delta < bestDelta) {
      best = rec;
      bestDelta = delta;
    }
  }
  return best;
}

function computeDurationMs(
  durationSeconds: number | null | undefined,
  startedAtIso: string,
  endedAtIso: string | null,
): number {
  if (typeof durationSeconds === "number" && Number.isFinite(durationSeconds)) {
    return Math.max(0, Math.round(durationSeconds * 1000));
  }
  if (endedAtIso) {
    const start = Date.parse(startedAtIso);
    const end = Date.parse(endedAtIso);
    if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) {
      return end - start;
    }
  }
  return 0;
}

/**
 * Convert any `Date.parse`-acceptable string into a canonical offset-tagged
 * ISO string so it satisfies `z.string().datetime({ offset: true })`.
 */
function normalizeIso(value: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new AdapterError(PROVIDER, `invalid timestamp from API: ${value}`);
  }
  return new Date(ms).toISOString();
}

/** Map one PostHog event row into a {@link NormalizedEvent}. */
function mapPersonEvent(event: PersonEvent): NormalizedEvent {
  const properties: Record<string, unknown> = event.properties ?? {};
  const type = classifyEventType(event.event, properties);
  return {
    timestamp: normalizeIso(event.timestamp),
    type,
    target: deriveTarget(event.event, type, properties),
    properties,
  };
}

/**
 * Fold PostHog's open-ended event taxonomy into our finite
 * {@link NormalizedEventType} set. Order matters: exception detection beats
 * autocapture classification.
 */
function classifyEventType(
  eventName: string,
  properties: Record<string, unknown>,
): NormalizedEventType {
  if (properties["$exception"] !== undefined) {
    return "error";
  }
  switch (eventName) {
    case "$pageview":
      return "navigation";
    case "$rageclick":
      return "rage_click";
    case "$dead_click":
      return "dead_click";
    case "$autocapture": {
      const subType = properties["$event_type"];
      if (subType === "click") return "click";
      if (subType === "change") return "input";
      return "other";
    }
    default:
      return "other";
  }
}

/**
 * Best-effort human-readable target string for an event. Navigation events
 * point at the URL; clicks prefer visible text and fall back to selector.
 */
function deriveTarget(
  eventName: string,
  type: NormalizedEventType,
  properties: Record<string, unknown>,
): string | null {
  if (type === "navigation") {
    return readString(properties, "$current_url");
  }
  if (eventName === "$autocapture") {
    return (
      readString(properties, "$el_text") ??
      readString(properties, "$element_selector")
    );
  }
  return null;
}

/**
 * Collapse consecutive identical URLs so 50 micro-renders on the same page
 * don't drown the breadcrumb trail.
 */
function buildPageViews(events: PersonEvent[]): PageView[] {
  const result: PageView[] = [];
  for (const event of events) {
    if (event.event !== "$pageview") continue;
    const properties: Record<string, unknown> = event.properties ?? {};
    const url = readString(properties, "$current_url");
    if (url === null) continue;
    const timestamp = normalizeIso(event.timestamp);
    const last = result[result.length - 1];
    if (last && last.url === url) {
      continue;
    }
    result.push({ url, timestamp });
  }
  // Stable chronological ordering even if the API returned newest-first.
  result.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return result;
}

function readString(
  source: Record<string, unknown>,
  key: string,
): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Compute the backoff for attempt `n` (0-indexed). Honors a server-supplied
 * Retry-After value when present; otherwise uses exponential backoff with
 * full jitter capped at ~5s to keep tail latency reasonable.
 */
function backoffDelayMs(
  attempt: number,
  retryAfterMs: number | undefined,
): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return Math.min(retryAfterMs, 10_000);
  }
  const exp = RETRY_BASE_DELAY_MS * 2 ** attempt;
  const capped = Math.min(exp, 5_000);
  return Math.floor(Math.random() * capped);
}

/** Parse a `Retry-After` header (seconds or HTTP-date) into milliseconds. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.round(asNumber * 1000);
  }
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    return Math.max(0, asDate - Date.now());
  }
  return undefined;
}

function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max)}…`;
}
