import { z, type ZodTypeAny } from "zod";

import { AdapterError, ValidationError } from "../../errors.js";
import { adapterFetch } from "./_shared.js";
import {
  normalizedErrorSchema,
  type NormalizedError,
  type Severity,
} from "../../types/error.js";
import type {
  ErrorAdapter,
  FetchRecentOptions,
} from "../../types/adapters.js";

/**
 * Default base URL for Rollbar's REST API.
 */
const DEFAULT_BASE_URL = "https://api.rollbar.com";

/**
 * Default page size when caller does not specify `limit`.
 */
const DEFAULT_LIMIT = 25;

/**
 * Hard upper bound on `limit` — Rollbar's items endpoint caps at 100 per page,
 * so larger callers buy nothing but a wasted query string.
 */
const MAX_LIMIT = 100;

/**
 * Number of stack frames retained in the normalized stack string.
 */
const MAX_STACK_FRAMES = 20;

/**
 * Number of trailing telemetry entries kept as breadcrumbs.
 */
const MAX_BREADCRUMBS = 10;

/**
 * Total HTTP attempts per request (initial + retries).
 *
 * Setting this to 4 yields 1 initial try + 3 retries, matching what we expose
 * everywhere else in crashscope. Naming it `MAX_ATTEMPTS` (rather than the
 * older `MAX_RETRIES`) avoids the classic off-by-one — `attempt < MAX_ATTEMPTS`
 * now means "I have attempts left".
 */
const MAX_ATTEMPTS = 4;

/**
 * Construction options for {@link RollbarAdapter}.
 */
export interface RollbarAdapterOptions {
  /** Read-scope Rollbar project access token. */
  readToken: string;
  /** Optional project slug used to build a more accurate `sourceUrl`. */
  project?: string;
  /** Override for the Rollbar API base URL (useful for tests). */
  baseUrl?: string;
}

// ---- Zod schemas (cover only the fields we consume) ----

const stackFrameSchema = z
  .object({
    filename: z.string().nullable().optional(),
    lineno: z.number().nullable().optional(),
    colno: z.number().nullable().optional(),
    method: z.string().nullable().optional(),
  })
  .passthrough();

const traceSchema = z
  .object({
    frames: z.array(stackFrameSchema).optional(),
    exception: z
      .object({
        class: z.string().optional(),
        message: z.string().optional(),
        description: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const telemetrySchema = z
  .object({
    timestamp_ms: z.number().optional(),
    type: z.string().optional(),
    level: z.string().optional(),
    source: z.string().optional(),
    body: z.unknown().optional(),
  })
  .passthrough();

const instanceDataSchema = z
  .object({
    timestamp: z.number().optional(),
    environment: z.string().nullable().optional(),
    language: z.string().nullable().optional(),
    framework: z.string().nullable().optional(),
    platform: z.string().nullable().optional(),
    level: z.string().optional(),
    body: z
      .object({
        trace_chain: z.array(traceSchema).optional(),
        trace: traceSchema.optional(),
        message: z
          .object({
            body: z.string().optional(),
          })
          .passthrough()
          .optional(),
        telemetry: z.array(telemetrySchema).optional(),
      })
      .passthrough()
      .optional(),
    person: z
      .object({
        id: z.union([z.string(), z.number()]).optional(),
        username: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    code_version: z.string().nullable().optional(),
    server: z
      .object({
        host: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const instanceSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    timestamp: z.number().optional(),
    data: instanceDataSchema.optional(),
  })
  .passthrough();

const instancesEnvelopeSchema = z.object({
  err: z.number().optional(),
  result: z
    .object({
      instances: z.array(instanceSchema).default([]),
    })
    .passthrough(),
});

const itemSchema = z
  .object({
    id: z.number(),
    counter: z.number().optional(),
    project_id: z.number().optional(),
    environment: z.string().nullable().optional(),
    framework: z.string().nullable().optional(),
    platform: z.string().nullable().optional(),
    language: z.string().nullable().optional(),
    level: z.string().optional(),
    status: z.string().optional(),
    title: z.string().optional(),
    hash: z.string().optional(),
    total_occurrences: z.number().optional(),
    unique_occurrences: z.number().nullable().optional(),
    first_occurrence_timestamp: z.number().nullable().optional(),
    last_occurrence_timestamp: z.number().nullable().optional(),
    last_occurrence_id: z.number().nullable().optional(),
    public_item_id: z.number().nullable().optional(),
    // Rollbar exposes a `uuid` (sometimes `last_occurrence_uuid`) on items
    // which deep-links to the canonical UI without an account slug. Captured
    // here so {@link RollbarAdapter.buildSourceUrl} can prefer it over a
    // potentially mis-routed `https://rollbar.com/item/uid/<id>` URL.
    uuid: z.string().nullable().optional(),
  })
  .passthrough();

const itemsEnvelopeSchema = z.object({
  err: z.number().optional(),
  result: z
    .object({
      items: z.array(itemSchema).default([]),
    })
    .passthrough(),
});

const itemDetailEnvelopeSchema = z.object({
  err: z.number().optional(),
  result: itemSchema,
});

type RollbarItem = z.infer<typeof itemSchema>;
type RollbarInstance = z.infer<typeof instanceSchema>;
type RollbarInstanceData = z.infer<typeof instanceDataSchema>;
type RollbarTrace = z.infer<typeof traceSchema>;
type RollbarStackFrame = z.infer<typeof stackFrameSchema>;
type RollbarTelemetry = z.infer<typeof telemetrySchema>;

/**
 * `ErrorAdapter` implementation for Rollbar (https://rollbar.com).
 *
 * Notes on the upstream API:
 * - Auth uses a project read token via `X-Rollbar-Access-Token`.
 * - `GET /api/1/items/` does not accept a time filter, so we clip client-side
 *   by `last_occurrence_timestamp` against the caller's `since`.
 * - The list endpoint may return more rows than `limit`; we truncate.
 * - Stack and breadcrumbs come from the latest instance (extra request).
 */
export class RollbarAdapter implements ErrorAdapter {
  public readonly name = "rollbar";

  private readonly readToken: string;
  private readonly project: string | undefined;
  private readonly baseUrl: string;

  public constructor(opts: RollbarAdapterOptions) {
    if (!opts.readToken) {
      throw new AdapterError(
        "rollbar",
        "readToken is required to construct a RollbarAdapter",
      );
    }
    this.readToken = opts.readToken;
    this.project = opts.project;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  public async fetchRecent(
    opts: FetchRecentOptions,
  ): Promise<NormalizedError[]> {
    // Clamp limit defensively: callers might pass `Infinity` or a non-integer
    // and Rollbar caps at 100 per page anyway.
    const limit = clampLimit(opts.limit);
    const sinceSeconds = Math.floor(opts.since.getTime() / 1000);
    const severityFilter = opts.severities
      ? new Set<Severity>(opts.severities)
      : null;

    const path = `/api/1/items/?status=active&limit=${encodeURIComponent(
      String(limit),
    )}`;
    const envelope = await this.rollbarGet(path, itemsEnvelopeSchema);

    // Best-effort client-side filter by `since`: the items endpoint does not
    // accept a time bound, so we drop items whose `last_occurrence_timestamp`
    // is older than `since` here. Because the slice/limit runs after this
    // filter, callers may legitimately get fewer than `limit` results when
    // many recent items predate the window.
    const filtered = envelope.result.items
      .filter((item: RollbarItem) => {
        const last = item.last_occurrence_timestamp;
        return typeof last === "number" ? last >= sinceSeconds : true;
      })
      .filter((item: RollbarItem) => {
        if (!severityFilter) return true;
        return severityFilter.has(mapLevelToSeverity(item.level));
      })
      .slice(0, limit);

    const detailed = await Promise.all(
      filtered.map((item: RollbarItem) => this.hydrate(item)),
    );
    return detailed;
  }

  public async fetchDetail(id: string): Promise<NormalizedError> {
    if (!id) {
      throw new AdapterError("rollbar", "fetchDetail requires a non-empty id");
    }
    // Drop the trailing slash so the URL matches the pattern Sentry and Bugsnag
    // use (`/api/1/item/<id>`). Rollbar accepts both forms today, but a single
    // shape across adapters makes auditing redirects and rate-limit policies
    // less surprising.
    const path = `/api/1/item/${encodeURIComponent(id)}`;
    const envelope = await this.rollbarGet(path, itemDetailEnvelopeSchema);
    return this.hydrate(envelope.result);
  }

  // ---- internal helpers ----

  /**
   * Fetch the latest instance for an item and project both into a
   * `NormalizedError`. Validates the final shape via `normalizedErrorSchema`.
   */
  private async hydrate(item: RollbarItem): Promise<NormalizedError> {
    const instance = await this.fetchLatestInstance(item.id);
    const data = instance?.data;
    const body = data?.body;

    const trace = pickTrace(body?.trace_chain, body?.trace);
    const stack = renderStack(trace);
    const breadcrumbs = renderBreadcrumbs(body?.telemetry);

    const exceptionClass = trace?.exception?.class;
    const exceptionMessage =
      trace?.exception?.message ??
      trace?.exception?.description ??
      body?.message?.body ??
      "";

    const title = item.title ?? exceptionMessage ?? exceptionClass ?? "Unknown";
    const type = exceptionClass ?? item.title ?? "Error";
    const messageText = exceptionMessage || title;

    const severity = mapLevelToSeverity(item.level);
    const totalOccurrences = nonNegativeInt(item.total_occurrences);
    const uniqueOccurrences =
      typeof item.unique_occurrences === "number"
        ? nonNegativeInt(item.unique_occurrences)
        : totalOccurrences;

    const firstSeen = toIsoString(item.first_occurrence_timestamp);
    const lastSeen = toIsoString(item.last_occurrence_timestamp, firstSeen);

    const sampleUserIds = collectSampleUserIds(data);
    const tags = collectTags(item, data);
    const sourceUrl = this.buildSourceUrl(item);
    const environment = item.environment ?? data?.environment ?? null;
    const releaseVersion = data?.code_version ?? null;

    const candidate: NormalizedError = {
      id: String(item.id),
      provider: "rollbar",
      title,
      message: messageText,
      type,
      stack,
      severity,
      environment,
      releaseVersion,
      affectedUsers: uniqueOccurrences,
      eventCount: totalOccurrences,
      firstSeen,
      lastSeen,
      sourceUrl,
      sampleUserIds,
      breadcrumbs,
      tags,
      raw: { item, instance },
    };

    const parsed = normalizedErrorSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new ValidationError(
        `[rollbar] failed to normalize item ${item.id}`,
        parsed.error,
      );
    }
    return parsed.data;
  }

  private async fetchLatestInstance(
    itemId: number,
  ): Promise<RollbarInstance | null> {
    const path = `/api/1/item/${itemId}/instances/?limit=1`;
    const envelope = await this.rollbarGet(path, instancesEnvelopeSchema);
    return envelope.result.instances[0] ?? null;
  }

  /**
   * Reconstruct a Rollbar UI deep link.
   *
   * Resolution order, most → least specific:
   * 1. If `project` was supplied and the item has a `counter`, build the
   *    canonical `/account/project/items/<counter>/` URL.
   * 2. Otherwise, if the item carries a `uuid`, use the documented
   *    `https://rollbar.com/redirect/by-uuid/<uuid>` redirect endpoint.
   * 3. Fall back to the API URL for the item. This still resolves (it's a
   *    valid URL per the {@link normalizedErrorSchema}), but is "untested"
   *    in the sense that we have not verified it round-trips through the UI
   *    on every Rollbar tenant.
   */
  private buildSourceUrl(item: RollbarItem): string {
    if (this.project && typeof item.counter === "number") {
      const [account, project] = this.project.includes("/")
        ? this.project.split("/", 2)
        : ["", this.project];
      if (account && project) {
        return `https://rollbar.com/${encodeURIComponent(
          account,
        )}/${encodeURIComponent(project)}/items/${item.counter}/`;
      }
      return `https://rollbar.com/${encodeURIComponent(project ?? "")}/items/${
        item.counter
      }/`;
    }
    if (typeof item.uuid === "string" && item.uuid.length > 0) {
      return `https://rollbar.com/redirect/by-uuid/${encodeURIComponent(
        item.uuid,
      )}`;
    }
    // Untested fallback: the API URL is always a syntactically valid URL,
    // so the normalized record stays well-formed even if this exact path
    // doesn't round-trip through every Rollbar tenant's UI.
    return `${this.baseUrl}/api/1/item/${item.id}`;
  }

  /**
   * Thin wrapper over the shared {@link adapterFetch} helper that supplies
   * Rollbar's `X-Rollbar-Access-Token` header. All HTTP retry / auth /
   * validation semantics live in the shared helper.
   */
  private async rollbarGet<TSchema extends ZodTypeAny>(
    path: string,
    schema: TSchema,
  ): Promise<z.infer<TSchema>> {
    return adapterFetch(
      `${this.baseUrl}${path}`,
      schema,
      {
        method: "GET",
        headers: {
          "X-Rollbar-Access-Token": this.readToken,
          Accept: "application/json",
        },
      },
      "rollbar",
      { maxAttempts: MAX_ATTEMPTS },
    );
  }
}

// ---- pure helpers (module-private) ----

function mapLevelToSeverity(level: string | undefined): Severity {
  switch (level) {
    case "critical":
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

function pickTrace(
  chain: RollbarTrace[] | undefined,
  fallback: RollbarTrace | undefined,
): RollbarTrace | undefined {
  if (chain && chain.length > 0) {
    return chain[chain.length - 1];
  }
  return fallback;
}

function renderStack(trace: RollbarTrace | undefined): string | null {
  const frames = trace?.frames;
  if (!frames || frames.length === 0) return null;
  const lines = frames
    .slice(-MAX_STACK_FRAMES)
    .reverse()
    .map((frame: RollbarStackFrame) => renderFrame(frame));
  return lines.join("\n");
}

function renderFrame(frame: RollbarStackFrame): string {
  const method = frame.method ?? "<anonymous>";
  const filename = frame.filename ?? "<unknown>";
  const lineno = typeof frame.lineno === "number" ? frame.lineno : 0;
  const colno = typeof frame.colno === "number" ? frame.colno : 0;
  return `at ${method} (${filename}:${lineno}:${colno})`;
}

function renderBreadcrumbs(
  telemetry: RollbarTelemetry[] | undefined,
): NormalizedError["breadcrumbs"] {
  if (!telemetry || telemetry.length === 0) return [];
  return telemetry.slice(-MAX_BREADCRUMBS).map((entry) => {
    const timestampMs =
      typeof entry.timestamp_ms === "number"
        ? entry.timestamp_ms
        : Date.now();
    const iso = new Date(timestampMs).toISOString();
    return {
      timestamp: iso,
      category: entry.type ?? entry.source ?? "telemetry",
      message: messageFromTelemetryBody(entry.body),
    };
  });
}

function messageFromTelemetryBody(body: unknown): string {
  if (body == null) return "";
  if (typeof body === "string") return body;
  if (typeof body === "object") {
    const obj = body as Record<string, unknown>;
    const message = obj["message"];
    if (message && typeof message === "object") {
      const inner = (message as Record<string, unknown>)["body"];
      if (typeof inner === "string") return inner;
    }
    if (typeof message === "string") return message;
    try {
      return JSON.stringify(body);
    } catch {
      return "[unserializable telemetry body]";
    }
  }
  return String(body);
}

function collectSampleUserIds(data: RollbarInstanceData | undefined): string[] {
  const personId = data?.person?.id;
  if (personId === undefined || personId === null) return [];
  return [String(personId)];
}

function collectTags(
  item: RollbarItem,
  data: RollbarInstanceData | undefined,
): Record<string, string> {
  const tags: Record<string, string> = {};
  const framework = item.framework ?? data?.framework;
  const environment = item.environment ?? data?.environment;
  const language = item.language ?? data?.language;
  const platform = item.platform ?? data?.platform;
  if (framework) tags["framework"] = framework;
  if (environment) tags["environment"] = environment;
  if (language) tags["language"] = language;
  if (platform) tags["platform"] = platform;
  return tags;
}

function nonNegativeInt(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const truncated = Math.trunc(value);
  return truncated < 0 ? 0 : truncated;
}

function toIsoString(
  epochSeconds: number | null | undefined,
  fallback?: string,
): string {
  if (typeof epochSeconds === "number" && Number.isFinite(epochSeconds)) {
    return new Date(epochSeconds * 1000).toISOString();
  }
  return fallback ?? new Date(0).toISOString();
}

/**
 * Clamp a caller-supplied limit into Rollbar's accepted range, defaulting if
 * the value is `Infinity`, NaN, or non-positive.
 */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const floored = Math.floor(limit);
  if (floored <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, floored));
}

// `backoffDelay`, `sleep`, `parseRetryAfter`, `describeError`, and
// `safeBodySnippet` previously lived here to support an in-file retry loop.
// After the refactor onto the shared {@link adapterFetch} helper, every
// wire-level concern lives in `_shared.ts` and these helpers became dead
// code.
