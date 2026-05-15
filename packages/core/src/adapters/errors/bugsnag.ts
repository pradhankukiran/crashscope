import { z, type ZodTypeAny } from "zod";

import { AdapterError, ValidationError } from "../../errors.js";
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
const MAX_RETRIES = 3;
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
    const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
    const params = new URLSearchParams();
    params.set("per_page", String(limit));
    params.set("sort", "last_seen");
    // Restrict to open errors only.
    params.append("filters[error.status][][type]", "eq");
    params.append("filters[error.status][][value]", "open");

    const path = `/projects/${encodeURIComponent(
      this.projectId,
    )}/errors?${params.toString()}`;
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

    const environment = raw.release_stages?.[0] ?? null;
    const releaseVersion =
      event?.app?.version ?? event?.app_version ?? null;

    const stack = this.buildStack(event);
    const breadcrumbs = this.extractBreadcrumbs(event);
    const sampleUserIds = this.extractSampleUserIds(event);
    const sourceUrl = this.buildSourceUrl(raw);
    const tags = this.buildTags(raw);

    const firstSeen = raw.first_seen ?? raw.last_seen ?? new Date(0).toISOString();
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
    const id = user.id ?? user.email;
    return id ? [id] : [];
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
      // Latest event is optional context; an error here shouldn't abort the
      // entire fetch. Swallow and continue with no stack/breadcrumbs.
      if (cause instanceof ValidationError) {
        throw cause;
      }
      return null;
    }
  }

  private async bugsnagGet<TSchema extends ZodTypeAny>(
    path: string,
    schema: TSchema,
  ): Promise<z.infer<TSchema>> {
    const url = `${this.baseUrl}${path}`;
    let attempt = 0;
    let lastError: unknown;
    while (attempt < MAX_RETRIES) {
      attempt += 1;
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
        if (attempt >= MAX_RETRIES) {
          throw new AdapterError(
            PROVIDER,
            `network error calling ${path}: ${String(
              (cause as Error)?.message ?? cause,
            )}`,
            { cause },
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

      const retryable = response.status === 429 || response.status >= 500;
      const bodyPreview = await this.safeReadText(response);
      lastError = new AdapterError(
        PROVIDER,
        `HTTP ${response.status} from ${path}: ${bodyPreview}`,
      );

      if (!retryable || attempt >= MAX_RETRIES) {
        throw lastError;
      }
      const retryAfter = this.parseRetryAfter(
        response.headers.get("retry-after"),
      );
      await this.sleep(retryAfter ?? this.backoffMs(attempt));
    }
    // Defensive — loop should always return or throw.
    throw lastError instanceof Error
      ? lastError
      : new AdapterError(PROVIDER, `exhausted retries for ${path}`);
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

  private backoffMs(attempt: number): number {
    const exponential = BASE_BACKOFF_MS * 2 ** (attempt - 1);
    const jitter = Math.random() * BASE_BACKOFF_MS;
    return exponential + jitter;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
