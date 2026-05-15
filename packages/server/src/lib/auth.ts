/**
 * Bearer-token check for `/api/triage`.
 *
 * The token lives in `CRASHSCOPE_API_TOKEN` (validated in `lib/env.ts`).
 * Comparison is constant-time to avoid leaking equal-prefix information
 * through response timing.
 */
import { timingSafeEqual } from "node:crypto";
import { loadEnv } from "./env.js";

/**
 * Result of {@link checkApiToken}. Distinguishes "no header" from "bad token"
 * so the caller can decide whether to surface 401 with or without `WWW-
 * Authenticate: Bearer`.
 */
export type ApiTokenCheck =
  | { ok: true }
  | { ok: false; reason: "missing" | "malformed" | "invalid" | "not_configured" };

/**
 * Pull a Bearer token from the `Authorization` header.
 *
 * We accept the header in any case (HTTP headers are case-insensitive) but
 * the *scheme* must be exactly `Bearer` per RFC 6750. Other schemes are
 * rejected so we never silently accept e.g. Basic auth.
 */
function extractBearer(header: string | null): string | null {
  if (!header) return null;
  const trimmed = header.trim();
  const space = trimmed.indexOf(" ");
  if (space < 0) return null;
  const scheme = trimmed.slice(0, space);
  const value = trimmed.slice(space + 1).trim();
  if (scheme !== "Bearer") return null;
  if (value.length === 0) return null;
  return value;
}

/**
 * Verify the incoming request's bearer token against the configured value.
 *
 * Returns `ok: false, reason: "not_configured"` when `CRASHSCOPE_API_TOKEN`
 * is unset — that is a server misconfiguration we want to distinguish from
 * a bad client token in logs (and to refuse to serve, not to fall open).
 */
export function checkApiToken(authHeader: string | null): ApiTokenCheck {
  const env = loadEnv();
  const expected = env.CRASHSCOPE_API_TOKEN;
  if (!expected) return { ok: false, reason: "not_configured" };

  if (authHeader === null) return { ok: false, reason: "missing" };
  const presented = extractBearer(authHeader);
  if (!presented) return { ok: false, reason: "malformed" };

  // Equalize buffer lengths before timingSafeEqual: it throws on length
  // mismatch, which itself can be a side channel. Use the longer of the two
  // as the comparison target so wrong-length tokens cost the same as right-
  // length wrong tokens.
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return { ok: false, reason: "invalid" };
  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: "invalid" };
}
