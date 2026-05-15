/**
 * GET /api/triage
 *
 * Programmatic triage endpoint.
 *
 * Auth: `Authorization: Bearer <CRASHSCOPE_API_TOKEN>` (constant-time).
 * Query:
 *   - `since`: window keyword (default 24h).
 *   - `limit`: 1-100 (default 25).
 *   - `severity`: comma-separated subset of fatal,error,warning,info.
 *
 * Responses are emitted with `Cache-Control: no-store` because the report is
 * computed live every time and we never want a CDN to serve stale, possibly
 * sensitive issue data.
 *
 * Errors:
 *   - 400 on malformed query parameters.
 *   - 401 on missing/invalid bearer token (with `WWW-Authenticate: Bearer`).
 *   - 500 on adapter / agent / config failures (with a stable request id).
 */
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import {
  AdapterError,
  AuthError,
  ConfigError,
  CrashscopeError,
  ValidationError,
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
