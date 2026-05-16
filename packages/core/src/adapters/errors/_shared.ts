import type { z, ZodTypeAny } from "zod";

import {
  AdapterError,
  AuthError,
  ValidationError,
  classifyHttpFailure,
} from "../../errors.js";

/**
 * Per-call knobs accepted by {@link adapterFetch}.
 *
 * These are deliberately small: the adapters that wrap this helper bake in
 * their own provider name, base URL, auth header construction, and Zod schema.
 */
export interface AdapterFetchOptions {
  /**
   * Maximum number of attempts (initial + retries). Default `4`
   * (one initial try + three retries). Capped at a sane upper bound to avoid
   * unbounded loops if a caller passes nonsense.
   */
  maxAttempts?: number;
  /** Per-request abort timeout in milliseconds. Default `15_000`. */
  timeoutMs?: number;
  /**
   * External abort signal — if it aborts, in-flight retries stop immediately.
   * The helper composes this with its own per-attempt timeout signal.
   */
  signal?: AbortSignal;
}

/** Default attempt budget: 1 initial + 3 retries. */
const DEFAULT_MAX_ATTEMPTS = 4;
/** Default per-attempt timeout. */
const DEFAULT_TIMEOUT_MS = 15_000;
/** Base for exponential backoff when no `Retry-After` header is provided. */
const BACKOFF_BASE_MS = 250;
/** Hard ceiling on attempts (sanity-cap if a caller passes Infinity). */
const ATTEMPT_CEILING = 10;

/**
 * Issue a GET request, validate the JSON body, and return the parsed shape.
 *
 * Centralises the retry/auth/validation semantics shared by every error
 * adapter. Each adapter still owns its own URL construction, auth header,
 * provider-specific quirks, and Zod schema — but the wire-level handling
 * (HTTP status taxonomy, `Retry-After`, backoff, abort, schema validation)
 * lives here so every adapter behaves identically.
 *
 * Status taxonomy (from {@link classifyHttpFailure}):
 * - 401/403 → {@link AuthError} (terminal — never retried).
 * - 429    → retryable {@link AdapterError}; honors `Retry-After`.
 * - 5xx    → retryable {@link AdapterError}; exponential backoff.
 * - other  → non-retryable {@link AdapterError}.
 * - network errors / aborts → retryable.
 */
export async function adapterFetch<TSchema extends ZodTypeAny>(
  url: string,
  schema: TSchema,
  init: RequestInit,
  provider: string,
  opts: AdapterFetchOptions = {},
): Promise<z.infer<TSchema>> {
  const maxAttemptsRequested = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxAttempts = clampAttempts(maxAttemptsRequested);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    // Compose external abort signal with per-attempt timeout.
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    const onExternalAbort = (): void => {
      controller.abort();
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        clearTimeout(timer);
        throw new AdapterError(provider, "request aborted by caller", {
          retryable: false,
        });
      }
      opts.signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onExternalAbort);
      // If the caller aborted us, propagate immediately — don't retry.
      if (opts.signal?.aborted) {
        throw new AdapterError(provider, "request aborted by caller", {
          cause: err,
          retryable: false,
        });
      }
      lastError = err;
      if (attempt + 1 >= maxAttempts) {
        throw new AdapterError(
          provider,
          `network error: ${describeError(err)}`,
          { cause: err, retryable: true },
        );
      }
      await sleep(backoffDelay(attempt));
      continue;
    }
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onExternalAbort);

    if (response.ok) {
      let json: unknown;
      try {
        json = await response.json();
      } catch (err) {
        throw new AdapterError(
          provider,
          `invalid JSON response: ${describeError(err)}`,
          { cause: err, retryable: false },
        );
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        throw new ValidationError(
          `[${provider}] response failed schema validation`,
          parsed.error,
        );
      }
      return parsed.data;
    }

    // Non-2xx. Read a snippet of the body for the error message.
    const snippet = await safeReadText(response, 400);
    const classified = classifyHttpFailure(
      provider,
      response.status,
      snippet || response.statusText || `HTTP ${response.status}`,
    );

    // Auth failures are terminal — never retry.
    if (classified instanceof AuthError) {
      throw classified;
    }

    // Non-retryable adapter errors (4xx other than 401/403/429) are terminal.
    if (classified instanceof AdapterError && !classified.retryable) {
      throw classified;
    }

    // Retryable: 429 or 5xx. Sleep and try again, unless we're out of attempts.
    lastError = classified;
    if (attempt + 1 >= maxAttempts) {
      throw classified;
    }

    const retryAfterMs = parseRetryAfter(
      response.headers.get("retry-after"),
    );
    await sleep(retryAfterMs ?? backoffDelay(attempt));
  }

  // Defensive — loop should always return or throw.
  throw new AdapterError(
    provider,
    `exhausted ${maxAttempts} attempts: ${describeError(lastError)}`,
    {
      retryable: true,
      ...(lastError instanceof Error ? { cause: lastError } : {}),
    },
  );
}

/**
 * Parse an HTTP `Retry-After` header.
 *
 * Accepts both the delta-seconds form ("30") and the HTTP-date form
 * ("Wed, 21 Oct 2015 07:28:00 GMT"). Returns milliseconds, or `null` if the
 * header is missing or unparseable.
 */
export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (trimmed.length === 0) return null;
  // Numeric form: delta in seconds.
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  // HTTP-date form.
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return null;
}

/**
 * Exponential backoff with full jitter, used when no `Retry-After` header is
 * present on a retryable response.
 *
 * Returns a delay in [base/2, base * 1.5) for attempt `n` where
 * `base = BACKOFF_BASE_MS * 2^n`.
 */
export function backoffDelay(attempt: number): number {
  const safeAttempt = Math.max(0, Math.min(attempt, 6));
  const base = BACKOFF_BASE_MS * 2 ** safeAttempt;
  const jitter = base * (0.5 + Math.random());
  return Math.floor(jitter);
}

function clampAttempts(requested: number): number {
  if (!Number.isFinite(requested)) return DEFAULT_MAX_ATTEMPTS;
  const floored = Math.floor(requested);
  if (floored < 1) return 1;
  if (floored > ATTEMPT_CEILING) return ATTEMPT_CEILING;
  return floored;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function safeReadText(response: Response, max: number): Promise<string> {
  try {
    const text = await response.text();
    if (text.length <= max) return text;
    return `${text.slice(0, max)}…`;
  } catch {
    return "";
  }
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
