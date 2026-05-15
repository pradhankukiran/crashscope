/**
 * `/api/triage` — programmatic triage endpoint.
 *
 * Two modes share this route:
 *
 * 1. `GET /api/triage`
 *    - Auth: `Authorization: Bearer <CRASHSCOPE_API_TOKEN>` (constant-time).
 *    - Credentials come from the server's environment.
 *    - Query: `since` (default 24h), `limit` (1-100, default 25),
 *      `severity` (comma-separated subset of fatal,error,warning,info).
 *
 * 2. `POST /api/triage` — public demo (powers the landing-page form).
 *    - NO bearer auth: this endpoint is intentionally public.
 *    - The visitor supplies every credential (error provider, session
 *      provider, Anthropic API key) in the JSON body. The server never reads
 *      its own env vars on this path, and nothing is persisted.
 *    - Body shape is validated with Zod; see {@link parseTriageBody}.
 *
 * Responses are emitted with `Cache-Control: no-store` because the report is
 * computed live every time and we never want a CDN to serve stale, possibly
 * sensitive issue data.
 *
 * Errors:
 *   - 400 on malformed query parameters or body.
 *   - 401 on missing/invalid bearer token (with `WWW-Authenticate: Bearer`).
 *   - 5xx on adapter / agent / config failures (with a stable request id).
 */
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  AdapterError,
  AuthError,
  ConfigError,
  CrashscopeError,
  ValidationError,
  crashscopeConfigSchema,
  type CrashscopeConfig,
} from "@crashscope/core";
import type { Severity } from "@crashscope/core";
import { checkApiToken } from "@/lib/auth";
import {
  isSinceKeyword,
  runTriage,
  type SinceKeyword,
} from "@/lib/triage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Vercel max function duration. Adapter+investigate work can take a while.
export const maxDuration = 300;

const VALID_SEVERITIES: ReadonlySet<Severity> = new Set<Severity>([
  "fatal",
  "error",
  "warning",
  "info",
]);

/**
 * Bag of validated query parameters. Separate from the raw URLSearchParams
 * so the caller can rely on narrowed types post-validation.
 */
interface ParsedQuery {
  since: SinceKeyword;
  limit: number;
  severities?: Severity[];
}

/** Validate and normalize the query string. */
function parseQuery(url: URL):
  | { ok: true; value: ParsedQuery }
  | { ok: false; message: string } {
  const sinceParam = url.searchParams.get("since") ?? "24h";
  if (!isSinceKeyword(sinceParam)) {
    return {
      ok: false,
      message: `Invalid 'since' value '${sinceParam}'. Allowed: 1h, 6h, 24h, 7d, 14d, 30d.`,
    };
  }

  const limitParam = url.searchParams.get("limit");
  let limit = 25;
  if (limitParam !== null) {
    const parsed = Number(limitParam);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
      return {
        ok: false,
        message: `Invalid 'limit' value '${limitParam}'. Must be an integer in [1, 100].`,
      };
    }
    limit = Math.floor(parsed);
  }

  const severityParam = url.searchParams.get("severity");
  let severities: Severity[] | undefined;
  if (severityParam) {
    const tokens = severityParam
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    const invalid = tokens.filter(
      (t) => !VALID_SEVERITIES.has(t as Severity),
    );
    if (invalid.length > 0) {
      return {
        ok: false,
        message: `Invalid 'severity' values: ${invalid.join(", ")}. Allowed: fatal, error, warning, info.`,
      };
    }
    severities = tokens as Severity[];
  }

  return {
    ok: true,
    value: severities
      ? { since: sinceParam, limit, severities }
      : { since: sinceParam, limit },
  };
}

/** Standardised JSON error response, with `Cache-Control: no-store`. */
function errorResponse(
  status: number,
  body: { error: string; message: string; requestId: string },
  extraHeaders: Record<string, string> = {},
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Request-Id": body.requestId,
      ...extraHeaders,
    },
  });
}

/**
 * Best-effort mapping from {@link CrashscopeError} to an HTTP status and
 * client-safe message. Internal details (stack traces, raw env values) stay
 * server-side; the request id lets ops correlate via logs.
 */
function classifyError(err: unknown): { status: number; error: string; message: string } {
  if (err instanceof AuthError) {
    return { status: 502, error: "UPSTREAM_AUTH_ERROR", message: err.message };
  }
  if (err instanceof ConfigError) {
    // Misconfiguration is the operator's problem, not the client's, but we
    // want them to see *what* is misconfigured.
    return { status: 500, error: "CONFIG_ERROR", message: err.message };
  }
  if (err instanceof ValidationError) {
    return { status: 502, error: "VALIDATION_ERROR", message: err.message };
  }
  if (err instanceof AdapterError) {
    return { status: 502, error: "ADAPTER_ERROR", message: err.message };
  }
  if (err instanceof CrashscopeError) {
    return { status: 500, error: err.code, message: err.message };
  }
  // Unknown error — never leak the raw message.
  return {
    status: 500,
    error: "INTERNAL_ERROR",
    message: "Triage failed. See server logs for details.",
  };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const url = new URL(req.url);

  // 1. Auth.
  const auth = checkApiToken(req.headers.get("authorization"));
  if (!auth.ok) {
    const status =
      auth.reason === "not_configured" ? 500 : 401;
    const message =
      auth.reason === "not_configured"
        ? "Server is missing CRASHSCOPE_API_TOKEN."
        : auth.reason === "missing"
          ? "Missing Authorization header."
          : auth.reason === "malformed"
            ? "Authorization header must be 'Bearer <token>'."
            : "Invalid API token.";
    console.warn(
      `[triage] auth_failed reason=${auth.reason} requestId=${requestId}`,
    );
    return errorResponse(
      status,
      { error: "UNAUTHORIZED", message, requestId },
      status === 401 ? { "WWW-Authenticate": "Bearer" } : {},
    );
  }

  // 2. Query validation.
  const parsed = parseQuery(url);
  if (!parsed.ok) {
    return errorResponse(400, {
      error: "BAD_REQUEST",
      message: parsed.message,
      requestId,
    });
  }

  // 3. Pipeline.
  console.info(
    `[triage] start requestId=${requestId} since=${parsed.value.since} limit=${parsed.value.limit}`,
  );
  try {
    const report = await runTriage({
      since: parsed.value.since,
      limit: parsed.value.limit,
      ...(parsed.value.severities
        ? { severities: parsed.value.severities }
        : {}),
    });
    console.info(
      `[triage] done requestId=${requestId} total=${report.summary.total} durationMs=${report.meta.durationMs}`,
    );
    return NextResponse.json(report, {
      headers: {
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
      },
    });
  } catch (err: unknown) {
    const { status, error, message } = classifyError(err);
    console.error(
      `[triage] failed requestId=${requestId} status=${status} error=${error}`,
      err,
    );
    return errorResponse(status, { error, message, requestId });
  }
}

// ---------------------------------------------------------------------------
// POST handler — public demo (landing-page form)
// ---------------------------------------------------------------------------

/**
 * Body schema for `POST /api/triage`.
 *
 * The `credentials` slot piggybacks on `crashscopeConfigSchema` so we inherit
 * the cross-field check that `credentials[errorProvider]` and
 * `credentials[sessionProvider]` must both be populated.
 *
 * `anthropic.apiKey` is *required* here (unlike the optional behavior in core),
 * because the public POST endpoint must never silently fall through to a
 * server-side env key or to the Claude Code subscription path. We extract it
 * as a non-optional field on the body and copy it back into the config we
 * forward to {@link runTriage}.
 */
const sinceKeywordSchema = z.enum([
  "1h",
  "6h",
  "24h",
  "7d",
  "14d",
  "30d",
]);

const severityFilterSchema = z.enum(["fatal", "error", "warning", "info"]);

const triageBodySchema = z.object({
  errorProvider: z.enum(["sentry", "rollbar", "bugsnag", "honeybadger"]),
  sessionProvider: z.enum(["posthog", "logrocket"]),
  credentials: z.object({
    sentry: z
      .object({
        token: z.string().min(1),
        org: z.string().min(1),
        project: z.string().min(1),
      })
      .optional(),
    rollbar: z
      .object({
        readToken: z.string().min(1),
        project: z.string().min(1).optional(),
      })
      .optional(),
    bugsnag: z
      .object({
        token: z.string().min(1),
        organizationId: z.string().min(1),
        projectId: z.string().min(1),
      })
      .optional(),
    honeybadger: z
      .object({
        token: z.string().min(1),
        projectId: z.string().min(1),
      })
      .optional(),
    posthog: z
      .object({
        apiKey: z.string().min(1),
        projectId: z.string().min(1),
        host: z.string().url().optional(),
      })
      .optional(),
    logrocket: z
      .object({
        apiKey: z.string().min(1),
        appSlug: z.string().min(1),
      })
      .optional(),
  }),
  anthropic: z.object({
    apiKey: z.string().min(1),
  }),
  opts: z.object({
    since: sinceKeywordSchema,
    limit: z.number().int().min(1).max(25),
    severities: z.array(severityFilterSchema).optional(),
  }),
});

type TriageBody = z.infer<typeof triageBodySchema>;

/**
 * Validate the incoming JSON body for `POST /api/triage`.
 *
 * Runs two passes:
 *   1. The local `triageBodySchema` validates shape.
 *   2. The full `crashscopeConfigSchema` from core re-validates the assembled
 *      config so the cross-field invariant
 *      "credentials[errorProvider] && credentials[sessionProvider] are set"
 *      is enforced with one canonical message.
 *
 * On success we return both the parsed body and the assembled config the
 * pipeline will consume.
 */
function parseTriageBody(
  json: unknown,
):
  | { ok: true; body: TriageBody; config: CrashscopeConfig }
  | { ok: false; message: string } {
  const shape = triageBodySchema.safeParse(json);
  if (!shape.success) {
    const issue = shape.error.issues[0];
    const path = issue?.path.join(".") || "(root)";
    const msg = issue?.message ?? "Invalid request body.";
    return { ok: false, message: `Invalid '${path}': ${msg}` };
  }
  const body = shape.data;

  const candidate: CrashscopeConfig = {
    errorProvider: body.errorProvider,
    sessionProvider: body.sessionProvider,
    outputs: ["json"],
    credentials: body.credentials,
    anthropic: { apiKey: body.anthropic.apiKey },
  };

  const cfg = crashscopeConfigSchema.safeParse(candidate);
  if (!cfg.success) {
    const issue = cfg.error.issues[0];
    const path = issue?.path.join(".") || "(root)";
    const msg = issue?.message ?? "Invalid configuration.";
    return { ok: false, message: `Invalid '${path}': ${msg}` };
  }

  return { ok: true, body, config: cfg.data };
}

/**
 * POST /api/triage — public demo mode.
 *
 * Intentionally **unauthenticated**: this endpoint is exposed to anonymous
 * visitors of the landing page. They paste their own credentials into the
 * form; we forward them transiently for one triage run and never store
 * anything server-side. Bearer auth lives on `GET` (env-driven mode) and does
 * not apply here.
 *
 * Rate limiting is not implemented yet; the call site below is a clean
 * injection point — wrap the handler entry with a limiter before reaching
 * `parseTriageBody`.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  // 1. Body parse.
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return errorResponse(400, {
      error: "BAD_REQUEST",
      message: "Request body must be valid JSON.",
      requestId,
    });
  }

  // 2. Schema + cross-field validation.
  const parsed = parseTriageBody(json);
  if (!parsed.ok) {
    return errorResponse(400, {
      error: "BAD_REQUEST",
      message: parsed.message,
      requestId,
    });
  }

  // 3. Anthropic key is mandatory for this endpoint. The schema already
  //    enforces non-empty, but we double-check here so the error message is
  //    explicit instead of a generic schema complaint.
  if (!parsed.body.anthropic.apiKey.trim()) {
    return errorResponse(400, {
      error: "BAD_REQUEST",
      message:
        "This endpoint requires anthropic.apiKey in the request body.",
      requestId,
    });
  }

  // 4. Pipeline.
  console.info(
    `[triage:post] start requestId=${requestId} errorProvider=${parsed.body.errorProvider} sessionProvider=${parsed.body.sessionProvider} since=${parsed.body.opts.since} limit=${parsed.body.opts.limit}`,
  );
  try {
    const report = await runTriage(
      {
        since: parsed.body.opts.since,
        limit: parsed.body.opts.limit,
        ...(parsed.body.opts.severities
          ? { severities: parsed.body.opts.severities }
          : {}),
      },
      parsed.config,
    );
    console.info(
      `[triage:post] done requestId=${requestId} total=${report.summary.total} durationMs=${report.meta.durationMs}`,
    );
    return NextResponse.json(report, {
      headers: {
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
      },
    });
  } catch (err: unknown) {
    const { status, error, message } = classifyError(err);
    console.error(
      `[triage:post] failed requestId=${requestId} status=${status} error=${error}`,
      err,
    );
    return errorResponse(status, { error, message, requestId });
  }
}
