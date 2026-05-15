import { z } from "zod";

import { AdapterError, ValidationError } from "../../errors.js";
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
const MAX_RETRIES = 3;
const MAX_FRAMES = 20;
const MAX_BREADCRUMBS = 10;
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Sentry's documented `statsPeriod` values. We snap arbitrary `since` Dates
 * to the closest standard window that fully covers the requested range.
 */
const STATS_PERIODS_HOURS: ReadonlyArray<{ window: string; hours: number }> = [
  { window: "1h", hours: 1 },
  { window: "24h", hours: 24 },
  { window: "7d", hours: 24 * 7 },
  { window: "14d", hours: 24 * 14 },
  { window: "30d", hours: 24 * 30 },
  { window: "90d", hours: 24 * 90 },
];

function pickStatsPeriod(since: Date, now: Date = new Date()): string {
  const elapsedHours = Math.max(
    0,
    (now.getTime() - since.getTime()) / (1000 * 60 * 60),
  );
  // Smallest standard window that still covers `elapsedHours`.
  for (const candidate of STATS_PERIODS_HOURS) {
    if (candidate.hours >= elapsedHours) {
      return candidate.window;
    }
  }
  // since is older than 90d — use the maximum supported window.
  return "90d";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
    const path =
      `/api/0/projects/${encodeURIComponent(this.org)}/${encodeURIComponent(this.project)}/issues/` +
      `?statsPeriod=${encodeURIComponent(statsPeriod)}` +
      `&query=${encodeURIComponent("is:unresolved")}` +
      `&limit=${limit}`;

    const issues = await this.sentryGet(path, sentryIssueListSchema);

    const allowed = opts.severities ? new Set<Severity>(opts.severities) : null;
    const filtered = allowed
      ? issues.filter((issue) => allowed.has(mapSeverity(issue.level)))
      : issues;

    const normalized: NormalizedError[] = [];
    for (const issue of filtered) {
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
      if (err instanceof AdapterError && err.message.includes("404")) {
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
      throw new AdapterError(
        PROVIDER,
        `issue ${issue.id} is missing firstSeen/lastSeen timestamps`,
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

  private async sentryGet<T>(
    path: string,
    schema: z.ZodType<T>,
    opts: SentryGetOptions = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let lastError: unknown = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/json",
          },
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        lastError = err;
        if (attempt >= MAX_RETRIES) {
          throw new AdapterError(
            PROVIDER,
            `network error calling ${path}: ${describeError(err)}`,
            { cause: err },
          );
        }
        await sleep(backoffDelay(attempt));
        continue;
      }
      clearTimeout(timer);

      if (response.status === 429) {
        const retryAfterMs =
          parseRetryAfter(response.headers.get("retry-after")) ??
          backoffDelay(attempt);
        if (attempt >= MAX_RETRIES) {
          throw new AdapterError(
            PROVIDER,
            `rate limited (429) calling ${path} after ${MAX_RETRIES + 1} attempts`,
          );
        }
        await sleep(retryAfterMs);
        continue;
      }

      if (response.status >= 500 && response.status < 600) {
        lastError = new Error(`HTTP ${response.status}`);
        if (attempt >= MAX_RETRIES) {
          throw new AdapterError(
            PROVIDER,
            `server error ${response.status} calling ${path} after ${MAX_RETRIES + 1} attempts`,
          );
        }
        await sleep(backoffDelay(attempt));
        continue;
      }

      if (!response.ok) {
        const bodyText = await safeReadText(response);
        throw new AdapterError(
          PROVIDER,
          `HTTP ${response.status} calling ${path}: ${truncate(bodyText, 400)}`,
        );
      }

      let json: unknown;
      try {
        json = await response.json();
      } catch (err) {
        throw new AdapterError(
          PROVIDER,
          `invalid JSON response from ${path}: ${describeError(err)}`,
          { cause: err },
        );
      }

      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        throw new ValidationError(
          `[${PROVIDER}] response from ${path} failed schema validation`,
          parsed.error,
        );
      }
      return parsed.data;
    }

    // Unreachable in practice — the loop either returns or throws.
    throw new AdapterError(
      PROVIDER,
      `exhausted retries calling ${path}: ${describeError(lastError)}`,
      lastError instanceof Error ? { cause: lastError } : undefined,
    );
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "<unserializable error>";
  }
}

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
