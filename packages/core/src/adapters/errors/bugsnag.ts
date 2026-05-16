import { z, type ZodTypeAny } from "zod";

import {
  AdapterError,
  AuthError,
  ValidationError,
  classifyHttpFailure,
} from "../../errors.js";
import type {
  ErrorAdapter,
  FetchRecentOptions,
} from "../../types/adapters.js";
import {
  type Breadcrumb,
  type NormalizedError,
  type Severity,
} from "../../types/error.js";

/**
 * Constructor options for {@link BugsnagAdapter}.
 *
 * `token` is a personal/data-access API token; it must be sent as
 * `Authorization: token {token}` per Bugsnag's Data Access API contract.
 */
export interface BugsnagAdapterOptions {
  /** Personal auth token with read access to the target project. */
  token: string;
  /** Bugsnag organization id (used to build source URLs). */
  organizationId: string;
  /** Bugsnag project id whose errors we fetch. */
  projectId: string;
  /**
   * Override the Data Access API base. Defaults to `https://api.bugsnag.com`.
   * Useful for testing or self-hosted Insight Hub deployments.
   */
  baseUrl?: string;
}

// ---------------------------------------------------------------------------
// HTTP / retry constants
// ---------------------------------------------------------------------------

const PROVIDER = "bugsnag";
const DEFAULT_BASE_URL = "https://api.bugsnag.com";
const DEFAULT_LIMIT = 25;
/** Bugsnag's Data Access API caps page size at 100. */
const MAX_LIMIT = 100;
/**
 * Total HTTP attempts per request (initial + retries). 4 = 1 initial + 3 retries.
 *
 * Replaces the older `MAX_RETRIES = 3` constant which was off-by-one — used
 * with `attempt < MAX_RETRIES` it meant only 3 total attempts. The new name
 * matches what the loop guard actually measures.
 */
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 250;
const MAX_BREADCRUMBS = 10;
const MAX_STACK_FRAMES = 20;

// ---------------------------------------------------------------------------
// Zod schemas — every external payload is validated through `.passthrough()`
// so unknown fields survive into the `raw` payload of `NormalizedError`.
// ---------------------------------------------------------------------------

const bugsnagSeveritySchema = z.enum(["info", "warning", "error"]);

const bugsnagErrorSchema = z
  .object({
    id: z.string(),
    project_id: z.string().optional(),
    error_class: z.string().optional(),
    message: z.string().optional(),
    context: z.string().nullish(),
    severity: bugsnagSeveritySchema.optional(),
    unhandled: z.boolean().optional(),
    users: z.number().int().nonnegative().optional(),
    events: z.number().int().nonnegative().optional(),
    first_seen: z.string().optional(),
    last_seen: z.string().optional(),
    release_stages: z.array(z.string()).optional(),
    url: z.string().optional(),
    severity_reason: z
      .object({ type: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
type BugsnagError = z.infer<typeof bugsnagErrorSchema>;

const bugsnagErrorListSchema = z.array(bugsnagErrorSchema);

const stackframeSchema = z
  .object({
    file: z.string().nullish(),
    method: z.string().nullish(),
    line_number: z.number().nullish(),
    column_number: z.number().nullish(),
  })
  .passthrough();
type BugsnagStackframe = z.infer<typeof stackframeSchema>;

const exceptionSchema = z
  .object({
    error_class: z.string().nullish(),
    message: z.string().nullish(),
    stacktrace: z.array(stackframeSchema).optional(),
  })
  .passthrough();

const breadcrumbPayloadSchema = z
  .object({
    timestamp: z.string().optional(),
    name: z.string().optional(),
    message: z.string().optional(),
    type: z.string().optional(),
    metaData: z.unknown().optional(),
  })
  .passthrough();
type BugsnagBreadcrumbPayload = z.infer<typeof breadcrumbPayloadSchema>;

const bugsnagEventSchema = z
  .object({
    id: z.string().optional(),
    received_at: z.string().optional(),
    exceptions: z.array(exceptionSchema).optional(),
    breadcrumbs: z.array(breadcrumbPayloadSchema).optional(),
    metaData: z
      .object({
        breadcrumbs: z.array(breadcrumbPayloadSchema).optional(),
      })
      .passthrough()
      .optional(),
    user: z
      .object({
        id: z.string().nullish(),
        email: z.string().nullish(),
        name: z.string().nullish(),
      })
      .passthrough()
      .optional(),
    app: z
      .object({
        version: z.string().nullish(),
        release_stage: z.string().nullish(),
      })
      .passthrough()
      .optional(),
    app_version: z.string().nullish(),
    context: z.string().nullish(),
  })
  .passthrough();
type BugsnagEvent = z.infer<typeof bugsnagEventSchema>;

// ---------------------------------------------------------------------------
// BugsnagAdapter
// ---------------------------------------------------------------------------

/**
 * Reads errors from Bugsnag's Data Access API and normalizes them.
 *
 * Endpoints used (all read-only):
 * - `GET /projects/{projectId}/errors` — list
 * - `GET /projects/{projectId}/errors/{errorId}` — detail
 * - `GET /projects/{projectId}/errors/{errorId}/latest_event` — stack/breadcrumbs
 *
 * Severity mapping follows Bugsnag's `severity` field with one twist: when the
 * latest event reports `unhandled === true`, the normalized severity is upgraded
 * to `"fatal"` (Bugsnag itself has no fatal level).
 */
export class BugsnagAdapter implements ErrorAdapter {
  public readonly name = PROVIDER;

  private readonly token: string;
  private readonly organizationId: string;
  private readonly projectId: string;
  private readonly baseUrl: string;

  public constructor(opts: BugsnagAdapterOptions) {
    if (!opts.token) {
      throw new AdapterError(PROVIDER, "token is required");
    }
    if (!opts.organizationId) {
      throw new AdapterError(PROVIDER, "organizationId is required");
    }
    if (!opts.projectId) {
      throw new AdapterError(PROVIDER, "projectId is required");
    }
    this.token = opts.token;
    this.organizationId = opts.organizationId;
    this.projectId = opts.projectId;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  public async fetchRecent(
    opts: FetchRecentOptions,
  ): Promise<NormalizedError[]> {
    const limit = clampLimit(opts.limit);
    // Bugsnag's filter syntax needs `type` and `value` to live in the **same**
    // array element (`filters[error.status][0][type]` /
    // `filters[error.status][0][value]`). `URLSearchParams.append` with
    // repeated `[]` produces two distinct elements which the API silently
    // ignores. Hand-build the query string so the indices line up.
    const query = [
      `per_page=${limit}`,
      `sort=last_seen`,
      `filters[error.status][0][type]=eq`,
      `filters[error.status][0][value]=open`,
    ].join("&");

    const path = `/projects/${encodeURIComponent(
      this.projectId,
    )}/errors?${query}`;
    const errors = await this.bugsnagGet(path, bugsnagErrorListSchema);

    const sinceMs = opts.since.getTime();
    const wantedSeverities = opts.severities
      ? new Set<Severity>(opts.severities)
      : null;

    // For each list entry we need the latest event for stack + breadcrumbs.
    const results: NormalizedError[] = [];
    for (const raw of errors) {
      const lastSeenMs = Date.parse(raw.last_seen ?? "");
      if (!Number.isNaN(lastSeenMs) && lastSeenMs < sinceMs) {
        continue;
      }
      const event = await this.tryFetchLatestEvent(raw.id);
      const normalized = this.normalize(raw, event);
      if (wantedSeverities && !wantedSeverities.has(normalized.severity)) {
        continue;
      }
      results.push(normalized);
      if (results.length >= limit) {
        break;
      }
    }
    return results;
  }

  public async fetchDetail(id: string): Promise<NormalizedError> {
    if (!id) {
      throw new AdapterError(PROVIDER, "id is required");
    }
    const path = `/projects/${encodeURIComponent(
      this.projectId,
    )}/errors/${encodeURIComponent(id)}`;
    const raw = await this.bugsnagGet(path, bugsnagErrorSchema);
    const event = await this.tryFetchLatestEvent(id);
    return this.normalize(raw, event);
  }

  // -------------------------------------------------------------------------
  // Normalization
  // -------------------------------------------------------------------------

  private normalize(
    raw: BugsnagError,
    event: BugsnagEvent | null,
  ): NormalizedError {
    const errorClass = raw.error_class ?? "Error";
    const message = raw.message ?? errorClass;
    const title = raw.context ? `${errorClass}: ${raw.context}` : errorClass;

    const unhandled = raw.unhandled === true || this.isUnhandled(event);
    const severity = this.mapSeverity(raw.severity, unhandled);

    // Prefer the latest event's `release_stage` — that's the stage that
    // actually produced the crash. Falling back to `release_stages[0]` picks
    // an arbitrary entry from the array, which is fine as a hint but not
    // authoritative.
    const environment =
      event?.app?.release_stage ?? raw.release_stages?.[0] ?? null;
    const releaseVersion =
      event?.app?.version ?? event?.app_version ?? null;

    const stack = this.buildStack(event);
    const breadcrumbs = this.extractBreadcrumbs(event);
    const sampleUserIds = this.extractSampleUserIds(event);
    const sourceUrl = this.buildSourceUrl(raw);
    const tags = this.buildTags(raw);

    // Don't paper over missing timestamps with `new Date(0)`: a record claiming
    // "first seen in 1970" poisons downstream sorting and freshness checks
    // worse than failing fast. Throw with the id so the operator can look the
    // payload up directly in Bugsnag.
    if (!raw.first_seen && !raw.last_seen) {
      throw new AdapterError(
        PROVIDER,
        `error ${raw.id} has neither first_seen nor last_seen — cannot normalize`,
      );
    }
    const firstSeen = raw.first_seen ?? (raw.last_seen as string);
    const lastSeen = raw.last_seen ?? firstSeen;

    return {
      id: raw.id,
      provider: PROVIDER,
      title,
      message,
      type: errorClass,
      stack,
      severity,
      environment,
      releaseVersion,
      affectedUsers: raw.users ?? 0,
      eventCount: raw.events ?? 0,
      firstSeen,
      lastSeen,
      sourceUrl,
      sampleUserIds,
      breadcrumbs,
      tags,
      raw: { error: raw, latest_event: event },
    };
  }

  private mapSeverity(
    severity: BugsnagError["severity"],
    unhandled: boolean,
  ): Severity {
    if (unhandled) {
      return "fatal";
    }
    switch (severity) {
      case "error":
        return "error";
      case "warning":
        return "warning";
      case "info":
        return "info";
      default:
        return "error";
    }
  }

  private isUnhandled(event: BugsnagEvent | null): boolean {
    if (!event) {
      return false;
    }
    const flag = (event as { unhandled?: unknown }).unhandled;
    return flag === true;
  }

  private buildStack(event: BugsnagEvent | null): string | null {
    const frames = event?.exceptions?.[0]?.stacktrace;
    if (!frames || frames.length === 0) {
      return null;
    }
    const limited: BugsnagStackframe[] = frames.slice(0, MAX_STACK_FRAMES);
    const rendered = limited.map((frame) => {
      const method = frame.method ?? "<anonymous>";
      const file = frame.file ?? "<unknown>";
      const line =
        typeof frame.line_number === "number" ? frame.line_number : 0;
      return `    at ${method} (${file}:${line})`;
    });
    return rendered.join("\n");
  }

  private extractBreadcrumbs(event: BugsnagEvent | null): Breadcrumb[] {
    if (!event) {
      return [];
    }
    const candidates =
      event.metaData?.breadcrumbs ?? event.breadcrumbs ?? [];
    if (candidates.length === 0) {
      return [];
    }
    const tail: BugsnagBreadcrumbPayload[] = candidates.slice(-MAX_BREADCRUMBS);
    const out: Breadcrumb[] = [];
    for (const crumb of tail) {
      const timestamp = this.toIsoString(crumb.timestamp);
      if (!timestamp) {
        continue;
      }
      // Bugsnag breadcrumb shape varies by SDK: most expose `type` as the
      // category (navigation/request/log/etc.) and `name` as the human label.
      // Some SDKs reuse `message` instead — fall back to that.
      const category = crumb.type ?? "manual";
      const message = crumb.name ?? crumb.message ?? "";
      out.push({ timestamp, category, message });
    }
    return out;
  }

  private extractSampleUserIds(event: BugsnagEvent | null): string[] {
    const user = event?.user;
    if (!user) {
      return [];
    }
    // Filter out null/undefined *and* empty strings. The previous code did
    // `user.id ?? user.email`, which kept `""` (an explicit empty id) and
    // poisoned downstream user-counting / session-correlation.
    const candidates: unknown[] = [user.id, user.email, user.name];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.length > 0) {
        return [candidate];
      }
    }
    return [];
  }

  private buildSourceUrl(raw: BugsnagError): string {
    if (raw.url && this.isUrl(raw.url)) {
      return raw.url;
    }
    // Without slug-fetching we cannot construct the canonical app URL — fall back
    // to a Data Access API URL that is at least a valid URL and round-trippable.
    return `${this.baseUrl}/projects/${encodeURIComponent(
      this.projectId,
    )}/errors/${encodeURIComponent(raw.id)}`;
  }

  private buildTags(raw: BugsnagError): Record<string, string> {
    const tags: Record<string, string> = {};
    if (raw.context) {
      tags.context = raw.context;
    }
    if (raw.error_class) {
      tags.error_class = raw.error_class;
    }
    if (raw.severity_reason?.type) {
      tags.severity_reason = raw.severity_reason.type;
    }
    if (this.organizationId) {
      tags.organization_id = this.organizationId;
    }
    return tags;
  }

  private toIsoString(value: string | undefined): string | null {
    if (!value) {
      return null;
    }
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) {
      return null;
    }
    return new Date(ms).toISOString();
  }

  private isUrl(value: string): boolean {
    try {
      // eslint-disable-next-line no-new
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // HTTP plumbing
  // -------------------------------------------------------------------------

  private async tryFetchLatestEvent(
    errorId: string,
  ): Promise<BugsnagEvent | null> {
    try {
      const path = `/projects/${encodeURIComponent(
        this.projectId,
      )}/errors/${encodeURIComponent(errorId)}/latest_event`;
      return await this.bugsnagGet(path, bugsnagEventSchema);
    } catch (cause) {
      // Latest event is optional context; a transient error here shouldn't
      // abort the entire fetch. ValidationError signals a schema drift we
      // want surfaced, and AuthError means credentials are bad — there's no
      // point soldiering on if either of those fires.
      if (cause instanceof ValidationError) {
        throw cause;
      }
      if (cause instanceof AuthError) {
        throw cause;
      }
      return null;
    }
  }

  /**
   * Issue a GET against the Bugsnag Data Access API.
   *
   * Authentication: Bugsnag's Data Access API uses `Authorization: token <T>`
   * (not `Bearer`). The `X-Version: 2` header pins the response schema to v2
   * so future schema bumps don't silently change the shape we validate against.
   *
   * Status taxonomy is normalised via {@link classifyHttpFailure}:
   * - 401/403 → {@link AuthError} (terminal — credentials problem).
   * - 429    → retryable, honoring `Retry-After`.
   * - 5xx    → retryable, exponential backoff with jitter.
   * - other  → non-retryable {@link AdapterError}.
   */
  private async bugsnagGet<TSchema extends ZodTypeAny>(
    path: string,
    schema: TSchema,
  ): Promise<z.infer<TSchema>> {
    const url = `${this.baseUrl}${path}`;
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: `token ${this.token}`,
            "X-Version": "2",
            Accept: "application/json",
          },
        });
      } catch (cause) {
        lastError = cause;
        if (attempt + 1 >= MAX_ATTEMPTS) {
          throw new AdapterError(
            PROVIDER,
            `network error calling ${path}: ${String(
              (cause as Error)?.message ?? cause,
            )}`,
            { cause, retryable: true },
          );
        }
        await this.sleep(this.backoffMs(attempt));
        continue;
      }

      if (response.ok) {
        let json: unknown;
        try {
          json = await response.json();
        } catch (cause) {
          throw new AdapterError(
            PROVIDER,
            `invalid JSON from ${path}`,
            { cause },
          );
        }
        const parsed = schema.safeParse(json);
        if (!parsed.success) {
          throw new ValidationError(
            `[bugsnag] response schema mismatch at ${path}`,
            parsed.error,
          );
        }
        return parsed.data;
      }

      const bodyPreview = await this.safeReadText(response);
      const classified = classifyHttpFailure(
        PROVIDER,
        response.status,
        `${path} ${bodyPreview}`.trim(),
      );
      if (classified instanceof AuthError) {
        // Auth failures are terminal — retrying just wastes attempts.
        throw classified;
      }
      if (!(classified instanceof AdapterError) || !classified.retryable) {
        throw classified;
      }
      lastError = classified;
      if (attempt + 1 >= MAX_ATTEMPTS) {
        throw classified;
      }
      const retryAfter = this.parseRetryAfter(
        response.headers.get("retry-after"),
      );
      await this.sleep(retryAfter ?? this.backoffMs(attempt));
    }
    // Defensive — loop should always return or throw.
    throw lastError instanceof Error
      ? lastError
      : new AdapterError(PROVIDER, `exhausted retries for ${path}`, {
          retryable: true,
        });
  }

  private async safeReadText(response: Response): Promise<string> {
    try {
      const text = await response.text();
      return text.length > 500 ? `${text.slice(0, 500)}...` : text;
    } catch {
      return "<no body>";
    }
  }

  private parseRetryAfter(header: string | null): number | null {
    if (!header) {
      return null;
    }
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
    const dateMs = Date.parse(header);
    if (!Number.isNaN(dateMs)) {
      const delta = dateMs - Date.now();
      return delta > 0 ? delta : 0;
    }
    return null;
  }

  /**
   * Exponential backoff with jitter, expecting a 0-based attempt index.
   * Capped to prevent the exponent from blowing up if `MAX_ATTEMPTS` is
   * ever raised.
   */
  private backoffMs(attempt: number): number {
    const safeAttempt = Math.max(0, Math.min(attempt, 6));
    const exponential = BASE_BACKOFF_MS * 2 ** safeAttempt;
    const jitter = Math.random() * BASE_BACKOFF_MS;
    return exponential + jitter;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}

/**
 * Clamp a caller-supplied `limit` to Bugsnag's accepted range, defaulting if
 * the input is `Infinity`, NaN, or non-positive. Bugsnag caps the list
 * endpoint at 100 per page so we never want to send anything higher.
 */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const floored = Math.floor(limit);
  if (floored <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, floored));
}
