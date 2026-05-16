import { z } from "zod";

import { AdapterError } from "../../errors.js";
import { adapterFetch } from "./_shared.js";
import type {
  ErrorAdapter,
  FetchRecentOptions,
} from "../../types/adapters.js";
import type {
  Breadcrumb,
  NormalizedError,
  Severity,
} from "../../types/error.js";

/**
 * Options accepted by the {@link SentryAdapter} constructor.
 */
export interface SentryAdapterOptions {
  /** Sentry auth token (organization or internal-integration). */
  token: string;
  /** Organization slug. */
  org: string;
  /** Project slug. */
  project: string;
  /**
   * Base URL of the Sentry instance. Defaults to `https://sentry.io`. Override
   * for self-hosted installations (e.g. `https://sentry.example.com`).
   */
  baseUrl?: string;
}

/**
 * Internal options for `sentryGet`. Kept narrow so the adapter doesn't accept
 * untyped fetch overrides.
 */
interface SentryGetOptions {
  /** Abort after this many ms (default 15s). */
  timeoutMs?: number;
}

// ----- Sentry API response schemas (lenient — only the fields we consume) -----

const sentryUserSchema = z
  .object({
    id: z.union([z.string(), z.number()]).nullish(),
    email: z.string().nullish(),
    username: z.string().nullish(),
  })
  .passthrough();

const sentryStackFrameSchema = z
  .object({
    function: z.string().nullish(),
    filename: z.string().nullish(),
    abs_path: z.string().nullish(),
    module: z.string().nullish(),
    lineno: z.number().nullish(),
    colno: z.number().nullish(),
  })
  .passthrough();

const sentryStackTraceSchema = z
  .object({
    frames: z.array(sentryStackFrameSchema).nullish(),
  })
  .passthrough();

const sentryExceptionValueSchema = z
  .object({
    type: z.string().nullish(),
    value: z.string().nullish(),
    stacktrace: sentryStackTraceSchema.nullish(),
  })
  .passthrough();

const sentryExceptionEntrySchema = z
  .object({
    type: z.literal("exception"),
    data: z
      .object({
        values: z.array(sentryExceptionValueSchema).nullish(),
      })
      .passthrough(),
  })
  .passthrough();

const sentryBreadcrumbValueSchema = z
  .object({
    timestamp: z.union([z.string(), z.number()]).nullish(),
    category: z.string().nullish(),
    type: z.string().nullish(),
    message: z.string().nullish(),
    level: z.string().nullish(),
  })
  .passthrough();

const sentryBreadcrumbEntrySchema = z
  .object({
    type: z.literal("breadcrumbs"),
    data: z
      .object({
        values: z.array(sentryBreadcrumbValueSchema).nullish(),
      })
      .passthrough(),
  })
  .passthrough();

const sentryGenericEntrySchema = z
  .object({
    type: z.string(),
    data: z.unknown().nullish(),
  })
  .passthrough();

const sentryEntrySchema = z.union([
  sentryExceptionEntrySchema,
  sentryBreadcrumbEntrySchema,
  sentryGenericEntrySchema,
]);

const sentryTagSchema = z
  .object({
    key: z.string(),
    value: z.union([z.string(), z.number(), z.boolean()]).nullish(),
  })
  .passthrough();

const sentryEventSchema = z
  .object({
    id: z.string().nullish(),
    eventID: z.string().nullish(),
    dateCreated: z.string().nullish(),
    entries: z.array(sentryEntrySchema).nullish(),
    tags: z.array(sentryTagSchema).nullish(),
    user: sentryUserSchema.nullish(),
  })
  .passthrough();

const sentryMetadataSchema = z
  .object({
    type: z.string().nullish(),
    value: z.string().nullish(),
    title: z.string().nullish(),
  })
  .passthrough();

const sentryIssueSchema = z
  .object({
    id: z.string(),
    shortId: z.string().nullish(),
    title: z.string().nullish(),
    culprit: z.string().nullish(),
    permalink: z.string().nullish(),
    level: z.string().nullish(),
    type: z.string().nullish(),
    status: z.string().nullish(),
    firstSeen: z.string().nullish(),
    lastSeen: z.string().nullish(),
    count: z.union([z.string(), z.number()]).nullish(),
    userCount: z.union([z.string(), z.number()]).nullish(),
    project: z
      .object({
        slug: z.string().nullish(),
        name: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
    metadata: sentryMetadataSchema.nullish(),
  })
  .passthrough();

const sentryIssueListSchema = z.array(sentryIssueSchema);

type SentryIssue = z.infer<typeof sentryIssueSchema>;
type SentryEvent = z.infer<typeof sentryEventSchema>;
type SentryExceptionValue = z.infer<typeof sentryExceptionValueSchema>;
type SentryStackFrame = z.infer<typeof sentryStackFrameSchema>;
type SentryBreadcrumbValue = z.infer<typeof sentryBreadcrumbValueSchema>;
type SentryEntry = z.infer<typeof sentryEntrySchema>;

// ----- Helpers -----

const PROVIDER = "sentry" as const;
const DEFAULT_BASE_URL = "https://sentry.io";
const DEFAULT_LIMIT = 25;
/**
 * Total HTTP attempts per request (initial + retries). 4 = 1 initial + 3
 * retries — same budget every crashscope adapter uses. Replaces the older
 * `MAX_RETRIES = 3` constant where `attempt <= MAX_RETRIES` quietly meant
 * the same thing; `MAX_ATTEMPTS` matches what the loop guard measures.
 */
const MAX_ATTEMPTS = 4;
const MAX_FRAMES = 20;
const MAX_BREADCRUMBS = 10;

/**
 * The Sentry issues endpoint only accepts a restricted set of statsPeriod
 * values: '', '24h', or '14d'. Other values that work elsewhere in the API
 * (1h, 7d, 30d, 90d) are rejected here with HTTP 400. We snap the caller's
 * `since` to the smallest supported window that covers it; ranges older than
 * 14d use '' (no time filter) and then rely on client-side filtering.
 *
 * Small tolerance (~5 min) prevents 24.0001-hour boundary fallouts.
 */
const TOLERANCE_HOURS = 5 / 60;

function pickStatsPeriod(since: Date, now: Date = new Date()): string {
  const elapsedHours = Math.max(
    0,
    (now.getTime() - since.getTime()) / (1000 * 60 * 60),
  );
  if (elapsedHours <= 24 + TOLERANCE_HOURS) return "24h";
  if (elapsedHours <= 14 * 24 + TOLERANCE_HOURS) return "14d";
  return "";
}

function mapSeverity(level: string | null | undefined): Severity {
  switch ((level ?? "").toLowerCase()) {
    case "fatal":
      return "fatal";
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "info":
    case "debug":
      return "info";
    default:
      return "error";
  }
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toIsoString(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    // Sentry breadcrumb timestamps are unix seconds (float).
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  }
  // Sentry returns ISO 8601; if missing tz, treat as UTC.
  const trimmed = value.trim();
  if (!trimmed) return null;
  const hasTz = /([zZ]|[+-]\d{2}:?\d{2})$/.test(trimmed);
  const candidate = hasTz ? trimmed : `${trimmed}Z`;
  const date = new Date(candidate);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function formatFrame(frame: SentryStackFrame): string {
  const fn = frame.function ?? "<anonymous>";
  const file = frame.filename ?? frame.abs_path ?? frame.module ?? "<unknown>";
  const lineno = frame.lineno ?? 0;
  const colno = frame.colno ?? 0;
  return `at ${fn} (${file}:${lineno}:${colno})`;
}

function pickExceptionValue(
  event: SentryEvent | null,
): SentryExceptionValue | null {
  const entries = event?.entries ?? [];
  for (const entry of entries) {
    if (isExceptionEntry(entry)) {
      const values = entry.data.values ?? [];
      // Sentry orders exception values root-first; the last value is typically
      // the deepest cause and carries the most relevant stack.
      const last = values.length > 0 ? values[values.length - 1] : undefined;
      if (last) return last;
    }
  }
  return null;
}

function isExceptionEntry(
  entry: SentryEntry,
): entry is z.infer<typeof sentryExceptionEntrySchema> {
  return entry.type === "exception";
}

function isBreadcrumbEntry(
  entry: SentryEntry,
): entry is z.infer<typeof sentryBreadcrumbEntrySchema> {
  return entry.type === "breadcrumbs";
}

function buildStack(event: SentryEvent | null): string | null {
  const exception = pickExceptionValue(event);
  const frames = exception?.stacktrace?.frames;
  if (!frames || frames.length === 0) return null;
  // Sentry returns frames in oldest-first order; the most relevant frames are
  // at the end (the throw site). Take the last N and reverse to top-of-stack.
  const slice = frames.slice(-MAX_FRAMES).reverse();
  const lines = slice.map((frame) => formatFrame(frame));
  return lines.length > 0 ? lines.join("\n") : null;
}

function buildBreadcrumbs(event: SentryEvent | null): Breadcrumb[] {
  const entries = event?.entries ?? [];
  for (const entry of entries) {
    if (!isBreadcrumbEntry(entry)) continue;
    const values = entry.data.values ?? [];
    const tail = values.slice(-MAX_BREADCRUMBS);
    const mapped: Breadcrumb[] = [];
    for (const value of tail) {
      const ts = toIsoString(value.timestamp ?? null);
      if (!ts) continue;
      mapped.push({
        timestamp: ts,
        category: value.category ?? value.type ?? "default",
        message: value.message ?? "",
      });
    }
    return mapped;
  }
  return [];
}

function buildTags(event: SentryEvent | null): Record<string, string> {
  const tags = event?.tags ?? [];
  const out: Record<string, string> = {};
  for (const tag of tags) {
    const key = tag.key;
    if (typeof key !== "string" || key.length === 0) continue;
    const raw = tag.value;
    if (raw === null || raw === undefined) continue;
    out[key] = typeof raw === "string" ? raw : String(raw);
  }
  return out;
}

function buildSampleUserIds(event: SentryEvent | null): string[] {
  const user = event?.user;
  if (!user) return [];
  // The empty-string guard intentionally lets `user.id === 0` through:
  // `String(0)` is `"0"`, which is a meaningful, distinct user id for systems
  // that count from zero. We only exclude `null`, `undefined`, and `""`.
  if (user.id !== null && user.id !== undefined && user.id !== "") {
    return [String(user.id)];
  }
  if (typeof user.email === "string" && user.email.length > 0) {
    return [user.email];
  }
  if (typeof user.username === "string" && user.username.length > 0) {
    return [user.username];
  }
  return [];
}

function pickEnvironmentAndRelease(event: SentryEvent | null): {
  environment: string | null;
  releaseVersion: string | null;
} {
  const tags = event?.tags ?? [];
  let environment: string | null = null;
  let releaseVersion: string | null = null;
  for (const tag of tags) {
    if (tag.key === "environment" && typeof tag.value === "string") {
      environment = tag.value;
    }
    if (tag.key === "release" && typeof tag.value === "string") {
      releaseVersion = tag.value;
    }
  }
  return { environment, releaseVersion };
}

function deriveTitleAndMessage(
  issue: SentryIssue,
  exception: SentryExceptionValue | null,
): { title: string; message: string; type: string } {
  const title = issue.title ?? issue.metadata?.title ?? issue.shortId ?? issue.id;
  const message =
    exception?.value ??
    issue.metadata?.value ??
    issue.culprit ??
    title;
  const type = exception?.type ?? issue.metadata?.type ?? issue.type ?? "Error";
  return { title, message, type };
}

function deriveSourceUrl(issue: SentryIssue, baseUrl: string, org: string): string {
  if (typeof issue.permalink === "string" && issue.permalink.length > 0) {
    return issue.permalink;
  }
  // Fallback: construct a best-effort URL.
  return `${baseUrl.replace(/\/+$/, "")}/organizations/${encodeURIComponent(org)}/issues/${encodeURIComponent(issue.id)}/`;
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    return Math.max(0, date - Date.now());
  }
  return null;
}

const BACKOFF_BASE_MS = [500, 1500, 4500] as const;

function backoffDelay(attempt: number): number {
  const idx = Math.min(attempt, BACKOFF_BASE_MS.length - 1);
  const base = BACKOFF_BASE_MS[idx] ?? 4500;
  // Full jitter: random value in [base/2, base * 1.5).
  const jitter = base * (0.5 + Math.random());
  return Math.floor(jitter);
}

/**
 * Sentry error tracker adapter.
 *
 * Talks to the Sentry HTTP API and projects issues/events into the crashscope
 * {@link NormalizedError} shape. The adapter is stateless beyond its
 * constructor options.
 */
export class SentryAdapter implements ErrorAdapter {
  public readonly name = PROVIDER;

  private readonly token: string;
  private readonly org: string;
  private readonly project: string;
  private readonly baseUrl: string;

  public constructor(opts: SentryAdapterOptions) {
    if (!opts.token) {
      throw new AdapterError(PROVIDER, "token is required");
    }
    if (!opts.org) {
      throw new AdapterError(PROVIDER, "org is required");
    }
    if (!opts.project) {
      throw new AdapterError(PROVIDER, "project is required");
    }
    this.token = opts.token;
    this.org = opts.org;
    this.project = opts.project;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  public async fetchRecent(opts: FetchRecentOptions): Promise<NormalizedError[]> {
    const limit = Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT));
    const statsPeriod = pickStatsPeriod(opts.since);
    // `sort=date` orders by `lastSeen` descending so pagination/truncation is
    // deterministic across calls. Sentry otherwise uses a relevance score that
    // varies between requests.
    const path =
      `/api/0/projects/${encodeURIComponent(this.org)}/${encodeURIComponent(this.project)}/issues/` +
      `?statsPeriod=${encodeURIComponent(statsPeriod)}` +
      `&query=${encodeURIComponent("is:unresolved")}` +
      `&sort=date` +
      `&limit=${limit}`;

    const issues = await this.sentryGet(path, sentryIssueListSchema);

    // Sentry's `statsPeriod` only takes a discrete set of windows ('24h',
    // '14d', ''). `pickStatsPeriod` rounds up to the smallest covering one,
    // so a 1h request will return up to 24h of issues. Post-filter to honor
    // the caller's `since` exactly. Note: this runs *before* the limit slice,
    // so we may legitimately return fewer than `limit` results.
    const sinceMs = opts.since.getTime();
    const recent = issues.filter((issue) => {
      if (!issue.lastSeen) return false;
      const lastSeen = Date.parse(issue.lastSeen);
      return Number.isFinite(lastSeen) && lastSeen >= sinceMs;
    });

    const allowed = opts.severities ? new Set<Severity>(opts.severities) : null;
    const filtered = allowed
      ? recent.filter((issue) => allowed.has(mapSeverity(issue.level)))
      : recent;

    const bounded = filtered.slice(0, limit);

    const normalized: NormalizedError[] = [];
    for (const issue of bounded) {
      const event = await this.fetchLatestEvent(issue.id);
      normalized.push(this.toNormalized(issue, event));
    }
    return normalized;
  }

  public async fetchDetail(id: string): Promise<NormalizedError> {
    if (!id) {
      throw new AdapterError(PROVIDER, "issue id is required");
    }
    const issue = await this.sentryGet(
      `/api/0/issues/${encodeURIComponent(id)}/`,
      sentryIssueSchema,
    );
    const event = await this.fetchLatestEvent(id);
    return this.toNormalized(issue, event);
  }

  // ----- internals -----

  private async fetchLatestEvent(issueId: string): Promise<SentryEvent | null> {
    try {
      return await this.sentryGet(
        `/api/0/issues/${encodeURIComponent(issueId)}/events/latest/`,
        sentryEventSchema,
      );
    } catch (err) {
      // Some issues legitimately have no fetchable latest event (e.g. retention
      // pruning). Don't fail the whole list — degrade to a stack-less record.
      // Use a word-boundary regex so we don't accidentally match `404` inside
      // a longer status code or body snippet (e.g. "HTTP 4040"). When the
      // core sibling adds a structured `status` field we can drop the regex.
      if (err instanceof AdapterError && /HTTP 404\b/.test(err.message)) {
        return null;
      }
      throw err;
    }
  }

  private toNormalized(
    issue: SentryIssue,
    event: SentryEvent | null,
  ): NormalizedError {
    const exception = pickExceptionValue(event);
    const { title, message, type } = deriveTitleAndMessage(issue, exception);
    const { environment, releaseVersion } = pickEnvironmentAndRelease(event);
    const firstSeen = toIsoString(issue.firstSeen ?? null);
    const lastSeen = toIsoString(issue.lastSeen ?? null);
    if (!firstSeen || !lastSeen) {
      // Reference the issue id (and shortId if present) so operators can pull
      // the offending payload out of Sentry directly when triaging.
      const ref = issue.shortId ? `${issue.id} (${issue.shortId})` : issue.id;
      throw new AdapterError(
        PROVIDER,
        `issue ${ref} is missing firstSeen=${String(issue.firstSeen)} ` +
          `lastSeen=${String(issue.lastSeen)} — cannot normalize`,
      );
    }

    return {
      id: issue.id,
      provider: PROVIDER,
      title,
      message,
      type,
      stack: buildStack(event),
      severity: mapSeverity(issue.level),
      environment,
      releaseVersion,
      affectedUsers: toNumber(issue.userCount, 0),
      eventCount: toNumber(issue.count, 0),
      firstSeen,
      lastSeen,
      sourceUrl: deriveSourceUrl(issue, this.baseUrl, this.org),
      sampleUserIds: buildSampleUserIds(event),
      breadcrumbs: buildBreadcrumbs(event),
      tags: buildTags(event),
      raw: issue,
    };
  }

  /**
   * Thin wrapper over the shared {@link adapterFetch} helper that supplies
   * Sentry's auth header and base URL. All retry / auth / validation
   * semantics live in the shared helper so every adapter behaves identically.
   */
  private async sentryGet<T>(
    path: string,
    schema: z.ZodType<T>,
    opts: SentryGetOptions = {},
  ): Promise<T> {
    return adapterFetch(
      `${this.baseUrl}${path}`,
      schema,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
        },
      },
      PROVIDER,
      {
        maxAttempts: MAX_ATTEMPTS,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      },
    );
  }
}

// `sleep`, `safeReadText`, `truncate`, and `describeError` previously lived
// here as supporting helpers for an in-file `sentryGet` HTTP loop. After the
// refactor onto the shared {@link adapterFetch} helper they are no longer
// needed: every wire-level concern lives in `_shared.ts`.

// Internal exports for testing. Not re-exported from the package barrel.
export const __internal = {
  pickStatsPeriod,
  mapSeverity,
  buildStack,
  buildBreadcrumbs,
  buildTags,
  buildSampleUserIds,
  parseRetryAfter,
  backoffDelay,
};
