import { z, type ZodTypeAny } from "zod";

import { AdapterError, ValidationError } from "../../errors.js";
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
 * Number of stack frames retained in the normalized stack string.
 */
const MAX_STACK_FRAMES = 20;

/**
 * Number of trailing telemetry entries kept as breadcrumbs.
 */
const MAX_BREADCRUMBS = 10;

/**
 * Maximum retry attempts for transient HTTP failures.
 */
const MAX_RETRIES = 3;

/**
 * Base delay (ms) for exponential backoff between retries.
 */
const BACKOFF_BASE_MS = 250;

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
    const limit = opts.limit > 0 ? opts.limit : DEFAULT_LIMIT;
    const sinceSeconds = Math.floor(opts.since.getTime() / 1000);
    const severityFilter = opts.severities
      ? new Set<Severity>(opts.severities)
      : null;

    const path = `/api/1/items/?status=active&limit=${encodeURIComponent(
      String(limit),
    )}`;
    const envelope = await this.rollbarGet(path, itemsEnvelopeSchema);

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
    const path = `/api/1/item/${encodeURIComponent(id)}/`;
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
   * Reconstruct a Rollbar UI deep link. If `project` was supplied we can build
   * the canonical `/account/project/items/<counter>/` form; otherwise we fall
   * back to the numeric item endpoint and document the limitation in a JSDoc
   * comment on this method.
   *
   * Limitation: the API does not return the account slug, so without an
   * out-of-band `project` option the URL points at the generic item route
   * which still resolves but is less human-friendly.
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
    return `https://rollbar.com/item/uid/${item.id}/`;
  }

  /**
   * Execute a GET against Rollbar, retrying transient 429/5xx responses with
   * exponential backoff + jitter. Validates the JSON body with `schema`.
   */
  private async rollbarGet<TSchema extends ZodTypeAny>(
    path: string,
    schema: TSchema,
  ): Promise<z.infer<TSchema>> {
    const url = `${this.baseUrl}${path}`;
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: {
            "X-Rollbar-Access-Token": this.readToken,
            Accept: "application/json",
          },
        });

        if (!response.ok) {
          if (isTransient(response.status) && attempt < MAX_RETRIES - 1) {
            await sleep(backoffDelay(attempt));
            continue;
          }
          const snippet = await safeBodySnippet(response);
          throw new AdapterError(
            "rollbar",
            `GET ${path} -> HTTP ${response.status}${
              snippet ? `: ${snippet}` : ""
            }`,
          );
        }

        const json: unknown = await response.json();
        const parsed = schema.safeParse(json);
        if (!parsed.success) {
          throw new ValidationError(
            `[rollbar] response shape mismatch for ${path}`,
            parsed.error,
          );
        }
        return parsed.data;
      } catch (err) {
        lastError = err;
        if (err instanceof AdapterError || err instanceof ValidationError) {
          throw err;
        }
        if (attempt < MAX_RETRIES - 1) {
          await sleep(backoffDelay(attempt));
          continue;
        }
      }
    }

    throw new AdapterError(
      "rollbar",
      `GET ${path} failed after ${MAX_RETRIES} attempts`,
      { cause: lastError },
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

function isTransient(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function backoffDelay(attempt: number): number {
  const base = BACKOFF_BASE_MS * 2 ** attempt;
  const jitter = Math.random() * BACKOFF_BASE_MS;
  return base + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function safeBodySnippet(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 200);
  } catch {
    return "";
  }
}
