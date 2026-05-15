import { z, type ZodError, type ZodTypeAny } from "zod";

import { AdapterError, ValidationError } from "../../errors.js";
import type {
  ErrorAdapter,
  FetchRecentOptions,
} from "../../types/adapters.js";
import type { NormalizedError, Severity } from "../../types/error.js";

/**
 * Default base URL for the Honeybadger API.
 */
const DEFAULT_BASE_URL = "https://app.honeybadger.io";

/**
 * Default page size when no explicit limit is supplied.
 */
const DEFAULT_LIMIT = 25;

/**
 * Retry budget for transient HTTP failures (429 / 5xx).
 *
 * Tuned to forgive a brief upstream blip without holding the event loop
 * hostage. Backoff is exponential with jitter so a fleet of adapters does not
 * stampede simultaneously.
 */
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 250;

/**
 * Maximum number of stack frames emitted into the normalized representation.
 *
 * Honeybadger sometimes returns very deep traces from framework code; keeping
 * the head is more useful for triage than truncating the application bits at
 * the bottom.
 */
const MAX_STACK_FRAMES = 20;

/**
 * Maximum breadcrumbs to retain (the most recent N).
 */
const MAX_BREADCRUMBS = 10;

/**
 * Construction options for {@link HoneybadgerAdapter}.
 */
export interface HoneybadgerAdapterOptions {
  /** Honeybadger personal/project auth token (used as HTTP basic username). */
  token: string;
  /** Numeric or string project id, as it appears in Honeybadger URLs. */
  projectId: string;
  /** Override the default base URL (e.g. for testing or self-hosted). */
  baseUrl?: string;
}

/**
 * Zod schema for a single Honeybadger fault as returned by the v2 API.
 *
 * Uses {@link z.ZodObject.passthrough} so future Honeybadger fields land in
 * `raw` untouched without breaking validation.
 */
const honeybadgerFaultSchema = z
  .object({
    id: z
      .union([z.string(), z.number()])
      .transform((v: string | number) => String(v)),
    klass: z.string().nullable().optional(),
    message: z.string().nullable().optional(),
    environment: z.string().nullable().optional(),
    notices_count: z.number().int().nonnegative().nullable().optional(),
    unique_occurrences: z.number().int().nonnegative().nullable().optional(),
    created_at: z.string(),
    last_notice_at: z.string().nullable().optional(),
    url: z.string().url(),
    tags: z.array(z.string()).nullable().optional(),
  })
  .passthrough();

type HoneybadgerFault = z.infer<typeof honeybadgerFaultSchema>;

const honeybadgerFaultListSchema = z
  .object({
    results: z.array(honeybadgerFaultSchema),
  })
  .passthrough();

const honeybadgerBacktraceFrameSchema = z
  .object({
    method: z.string().nullable().optional(),
    file: z.string().nullable().optional(),
    number: z.union([z.string(), z.number()]).nullable().optional(),
  })
  .passthrough();

type HoneybadgerBacktraceFrame = z.infer<typeof honeybadgerBacktraceFrameSchema>;

const honeybadgerBreadcrumbSchema = z
  .object({
    timestamp: z.string(),
    category: z.string().nullable().optional(),
    message: z.string().nullable().optional(),
  })
  .passthrough();

type HoneybadgerBreadcrumb = z.infer<typeof honeybadgerBreadcrumbSchema>;

const honeybadgerNoticeSchema = z
  .object({
    backtrace: z.array(honeybadgerBacktraceFrameSchema).nullable().optional(),
    breadcrumbs: z
      .object({
        trail: z.array(honeybadgerBreadcrumbSchema).nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    context: z
      .object({
        user_id: z
          .union([z.string(), z.number()])
          .nullable()
          .optional()
          .transform((v: string | number | null | undefined) =>
            v == null ? undefined : String(v),
          ),
        user_email: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    web_environment: z
      .object({
        HTTP_X_USER_ID: z
          .union([z.string(), z.number()])
          .nullable()
          .optional()
          .transform((v: string | number | null | undefined) =>
            v == null ? undefined : String(v),
          ),
      })
      .passthrough()
      .nullable()
      .optional(),
    app: z
      .object({
        deploy: z
          .object({
            revision: z.string().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    tags: z
      .object({
        revision: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

type HoneybadgerNotice = z.infer<typeof honeybadgerNoticeSchema>;

const honeybadgerNoticeListSchema = z
  .object({
    results: z.array(honeybadgerNoticeSchema),
  })
  .passthrough();

/**
 * Sleep helper that resolves after `ms` milliseconds.
 *
 * Kept module-private so tests can stub `globalThis.setTimeout` if needed.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Base64-encode a UTF-8 string in a way that works on Node and edge runtimes.
 *
 * Node 20+ exposes a global `btoa`; some older runtimes only have `Buffer`.
 * Prefer the standard primitive when available.
 */
function encodeBasicAuthHeader(token: string): string {
  const raw = `${token}:`;
  if (typeof btoa === "function") {
    return `Basic ${btoa(raw)}`;
  }
  // Fall back to Node's Buffer when running in a runtime without `btoa`.
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

/**
 * True for HTTP statuses we should retry (rate limit + transient server errors).
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Derive a normalized {@link Severity} from a fault's `klass` string.
 *
 * Honeybadger has no first-class severity on faults; convention is encoded in
 * the exception class name. We err on the side of "error" so unrecognised
 * classes don't get silently downgraded.
 */
function severityFromKlass(klass: string | null | undefined): Severity {
  if (!klass) return "error";
  if (/fatal/i.test(klass)) return "fatal";
  if (/warn/i.test(klass)) return "warning";
  return "error";
}

/**
 * Normalize a Honeybadger ISO-ish timestamp string to a strict offset-bearing
 * ISO-8601 value, which is what {@link NormalizedError} requires.
 *
 * Honeybadger emits both `Z` and `+00:00` variants; we accept either and
 * canonicalise via `Date`.
 */
function toIsoOffset(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AdapterError(
      "honeybadger",
      `Invalid timestamp from Honeybadger: ${value}`,
    );
  }
  return parsed.toISOString();
}

/**
 * Format a Honeybadger backtrace into a single newline-delimited string.
 *
 * Frames missing `method`/`file` are tolerated — we substitute "<unknown>" so
 * the slot remains visible rather than producing a malformed `at  ()` line.
 */
function formatStack(notice: HoneybadgerNotice | undefined): string | null {
  const frames = notice?.backtrace ?? [];
  if (frames.length === 0) return null;

  const lines = frames
    .slice(0, MAX_STACK_FRAMES)
    .map((frame: HoneybadgerBacktraceFrame) => {
      const method = frame.method ?? "<unknown>";
      const file = frame.file ?? "<unknown>";
      const line = frame.number == null ? "0" : String(frame.number);
      return `at ${method} (${file}:${line})`;
    });

  return lines.join("\n");
}

/**
 * Extract up to {@link MAX_BREADCRUMBS} normalized breadcrumbs from a notice.
 *
 * We keep the *tail* of the trail because the most recent actions before the
 * crash are the most diagnostically valuable.
 */
function extractBreadcrumbs(
  notice: HoneybadgerNotice | undefined,
): NormalizedError["breadcrumbs"] {
  const trail = notice?.breadcrumbs?.trail ?? [];
  if (trail.length === 0) return [];

  const tail = trail.slice(-MAX_BREADCRUMBS);
  return tail.map((crumb: HoneybadgerBreadcrumb) => ({
    timestamp: toIsoOffset(crumb.timestamp),
    category: crumb.category ?? "default",
    message: crumb.message ?? "",
  }));
}

/**
 * Collect any user-identifying strings present on a notice.
 *
 * Order matters: we de-duplicate so callers don't see "42" twice when both
 * `context.user_id` and `web_environment.HTTP_X_USER_ID` carry the same value.
 */
function extractSampleUserIds(notice: HoneybadgerNotice | undefined): string[] {
  if (!notice) return [];
  const ids: string[] = [];
  const ctx = notice.context;
  if (ctx?.user_id) ids.push(ctx.user_id);
  if (ctx?.user_email) ids.push(ctx.user_email);
  const headerId = notice.web_environment?.HTTP_X_USER_ID;
  if (headerId) ids.push(headerId);

  return Array.from(new Set(ids));
}

/**
 * Resolve a release version from notice metadata, preferring the structured
 * deploy field over the freeform tag.
 */
function extractReleaseVersion(
  notice: HoneybadgerNotice | undefined,
): string | null {
  const fromDeploy = notice?.app?.deploy?.revision;
  if (fromDeploy) return fromDeploy;
  const fromTags = notice?.tags?.revision;
  if (fromTags) return fromTags;
  return null;
}

/**
 * Convert a fault's tag list (`["foo", "bar"]`) into the record shape
 * {@link NormalizedError.tags} expects.
 *
 * Honeybadger tags carry no value semantics, so we use "true" as a stable
 * marker to indicate presence.
 */
function tagsToRecord(
  tags: readonly string[] | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!tags) return out;
  for (const tag of tags) {
    if (tag.length > 0) out[tag] = "true";
  }
  return out;
}

/**
 * Adapter for Honeybadger's REST API.
 *
 * Translates Honeybadger faults (with their most recent notice for stack /
 * breadcrumb context) into the shared {@link NormalizedError} shape used by
 * the rest of crashscope.
 */
export class HoneybadgerAdapter implements ErrorAdapter {
  public readonly name = "honeybadger";

  private readonly token: string;
  private readonly projectId: string;
  private readonly baseUrl: string;
  private readonly authHeader: string;

  public constructor(opts: HoneybadgerAdapterOptions) {
    if (!opts.token || opts.token.length === 0) {
      throw new AdapterError(
        this.name,
        "token is required to construct HoneybadgerAdapter",
      );
    }
    if (!opts.projectId || opts.projectId.length === 0) {
      throw new AdapterError(
        this.name,
        "projectId is required to construct HoneybadgerAdapter",
      );
    }

    this.token = opts.token;
    this.projectId = opts.projectId;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.authHeader = encodeBasicAuthHeader(this.token);
  }

  public async fetchRecent(
    opts: FetchRecentOptions,
  ): Promise<NormalizedError[]> {
    const limit = opts.limit > 0 ? opts.limit : DEFAULT_LIMIT;
    const path = `/v2/projects/${encodeURIComponent(
      this.projectId,
    )}/faults?q=${encodeURIComponent(
      "is:unresolved",
    )}&limit=${limit}&order=recent`;

    const list = await this.honeybadgerGet(path, honeybadgerFaultListSchema);

    // Filter by `since` and (if provided) severity. We hydrate each surviving
    // fault with its latest notice to fill in stack / breadcrumb fields.
    const sinceMs = opts.since.getTime();
    const severityFilter = opts.severities && opts.severities.length > 0
      ? new Set<Severity>(opts.severities)
      : null;

    const normalized: NormalizedError[] = [];
    for (const fault of list.results) {
      const lastSeenSource = fault.last_notice_at ?? fault.created_at;
      const lastSeenMs = new Date(lastSeenSource).getTime();
      if (!Number.isNaN(lastSeenMs) && lastSeenMs < sinceMs) continue;

      const severity = severityFromKlass(fault.klass);
      if (severityFilter && !severityFilter.has(severity)) continue;

      const notice = await this.fetchLatestNotice(fault.id);
      normalized.push(this.toNormalized(fault, notice));
      if (normalized.length >= limit) break;
    }

    return normalized;
  }

  public async fetchDetail(id: string): Promise<NormalizedError> {
    if (!id || id.length === 0) {
      throw new AdapterError(this.name, "fetchDetail requires a non-empty id");
    }

    const faultPath = `/v2/projects/${encodeURIComponent(
      this.projectId,
    )}/faults/${encodeURIComponent(id)}`;

    const fault = await this.honeybadgerGet(faultPath, honeybadgerFaultSchema);
    const notice = await this.fetchLatestNotice(fault.id);
    return this.toNormalized(fault, notice);
  }

  /**
   * Convert a fault + (optional) latest notice into the normalized shape.
   *
   * The notice is optional because some faults have no notices yet (rare but
   * possible during a flush window). All notice-derived fields degrade
   * gracefully to empty/null.
   */
  private toNormalized(
    fault: HoneybadgerFault,
    notice: HoneybadgerNotice | undefined,
  ): NormalizedError {
    const noticesCount = fault.notices_count ?? 0;
    const affectedUsers = fault.unique_occurrences ?? noticesCount;
    const lastSeenSource = fault.last_notice_at ?? fault.created_at;

    return {
      id: fault.id,
      provider: "honeybadger",
      title: fault.klass ?? fault.message ?? "Unknown fault",
      message: fault.message ?? "",
      type: fault.klass ?? "Error",
      stack: formatStack(notice),
      severity: severityFromKlass(fault.klass),
      environment: fault.environment ?? null,
      releaseVersion: extractReleaseVersion(notice),
      affectedUsers,
      eventCount: noticesCount,
      firstSeen: toIsoOffset(fault.created_at),
      lastSeen: toIsoOffset(lastSeenSource),
      sourceUrl: fault.url,
      sampleUserIds: extractSampleUserIds(notice),
      breadcrumbs: extractBreadcrumbs(notice),
      tags: tagsToRecord(fault.tags),
      raw: { fault, notice: notice ?? null },
    };
  }

  /**
   * Fetch the most recent notice for a fault. Returns `undefined` if the
   * fault exists but has no notices yet — callers treat that as "no
   * stack/breadcrumbs available" rather than failing outright.
   */
  private async fetchLatestNotice(
    faultId: string,
  ): Promise<HoneybadgerNotice | undefined> {
    const path = `/v2/projects/${encodeURIComponent(
      this.projectId,
    )}/faults/${encodeURIComponent(faultId)}/notices?limit=1`;

    const result = await this.honeybadgerGet(path, honeybadgerNoticeListSchema);
    return result.results[0];
  }

  /**
   * Issue a `GET` against the Honeybadger API and validate the response with
   * the supplied Zod schema. Retries on 429/5xx with exponential backoff +
   * jitter. Throws {@link AdapterError} on persistent failure and
   * {@link ValidationError} when the response shape is wrong.
   *
   * Kept generic over the schema's inferred output so call sites stay
   * fully type-checked without resorting to `any`.
   */
  private async honeybadgerGet<S extends ZodTypeAny>(
    path: string,
    schema: S,
  ): Promise<z.infer<S>> {
    const url = `${this.baseUrl}${path}`;
    let lastErr: unknown;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: this.authHeader,
          },
        });

        if (response.ok) {
          const json: unknown = await response.json();
          const parsed = schema.safeParse(json);
          if (!parsed.success) {
            throw new ValidationError(
              `[${this.name}] response from ${path} failed schema validation`,
              parsed.error as ZodError,
            );
          }
          return parsed.data as z.infer<S>;
        }

        // Non-2xx. Decide whether to retry or fail fast.
        if (!isRetryableStatus(response.status) || attempt === MAX_RETRIES - 1) {
          const body = await response.text().catch(() => "");
          throw new AdapterError(
            this.name,
            `GET ${path} failed with status ${response.status}${
              body ? `: ${body.slice(0, 256)}` : ""
            }`,
          );
        }
        lastErr = new AdapterError(
          this.name,
          `GET ${path} transient status ${response.status}`,
        );
      } catch (err) {
        // ValidationError and non-retryable AdapterError bubble immediately.
        if (err instanceof ValidationError) throw err;
        if (
          err instanceof AdapterError &&
          !/transient status/i.test(err.message)
        ) {
          throw err;
        }
        lastErr = err;
        if (attempt === MAX_RETRIES - 1) break;
      }

      // Exponential backoff with full jitter: sleep in [0, 2^attempt * base).
      const ceiling = BASE_BACKOFF_MS * 2 ** attempt;
      const wait = Math.floor(Math.random() * ceiling);
      await sleep(wait);
    }

    throw new AdapterError(
      this.name,
      `GET ${path} failed after ${MAX_RETRIES} attempts`,
      { cause: lastErr },
    );
  }
}
