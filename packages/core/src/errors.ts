import type { ZodError } from "zod";

/**
 * Base class for all errors crashscope throws.
 *
 * Carries a stable {@link code} so call sites can branch on category without
 * relying on `instanceof` across package boundaries. Subclasses preserve the
 * original error as {@link cause} when wrapping.
 */
export abstract class CrashscopeError extends Error {
  public abstract readonly code: string;

  public override readonly cause: unknown;

  protected constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    this.cause = options?.cause;
    // Maintain a proper prototype chain across down-leveled targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * An adapter (Sentry, PostHog, etc.) failed to fulfill a request.
 *
 * `provider` is the adapter's {@link ErrorAdapter.name} or
 * {@link SessionAdapter.name} so users can see which integration broke.
 *
 * `retryable` is `true` when the failure looks transient (e.g. HTTP 429 or 5xx,
 * network blip). Adapters set this explicitly rather than asking callers to
 * substring-match on `.message`. Defaults to `false`.
 */
export class AdapterError extends CrashscopeError {
  public readonly code = "ADAPTER_ERROR";
  public readonly provider: string;
  public readonly retryable: boolean;

  public constructor(
    provider: string,
    message: string,
    options?: { cause?: unknown; retryable?: boolean },
  ) {
    super(
      `[${provider}] ${message}`,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.provider = provider;
    this.retryable = options?.retryable ?? false;
  }
}

/**
 * Configuration is malformed (e.g. missing field, unreadable file).
 *
 * Use {@link ValidationError} when the failure is specifically a Zod schema
 * mismatch — `ConfigError` is for higher-level loading/parsing problems.
 */
export class ConfigError extends CrashscopeError {
  public readonly code = "CONFIG_ERROR";

  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * Authentication or authorization with a provider failed.
 *
 * Distinguished from {@link AdapterError} so the CLI can render a targeted
 * "check your credentials" hint instead of a generic adapter trace.
 */
export class AuthError extends CrashscopeError {
  public readonly code = "AUTH_ERROR";
  public readonly provider: string;

  public constructor(
    provider: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`[${provider}] ${message}`, options);
    this.provider = provider;
  }
}

/**
 * A Zod schema check failed.
 *
 * Wraps the underlying {@link ZodError} so consumers don't need to import zod
 * directly to inspect issues.
 */
export class ValidationError extends CrashscopeError {
  public readonly code = "VALIDATION_ERROR";
  public readonly zodError: ZodError;

  public constructor(message: string, zodError: ZodError) {
    super(message, { cause: zodError });
    this.zodError = zodError;
  }

  /** Flatten the underlying zod issues for compact display. */
  public get issues(): ZodError["issues"] {
    return this.zodError.issues;
  }
}

/**
 * Classify an HTTP failure from an adapter and produce the right error type.
 *
 * Adapters call this after a non-2xx response so the rest of crashscope can
 * branch on a stable taxonomy:
 * - 401/403 → {@link AuthError} (CLI renders a "check credentials" hint).
 * - 429    → retryable {@link AdapterError} (caller backs off and retries).
 * - 5xx    → retryable {@link AdapterError} (transient upstream failure).
 * - otherwise → non-retryable {@link AdapterError}.
 *
 * `detail` should be a short, user-visible string (e.g. truncated response
 * body or status text). `cause` preserves the underlying error if any.
 */
export function classifyHttpFailure(
  provider: string,
  status: number,
  detail: string,
  cause?: unknown,
): CrashscopeError {
  if (status === 401 || status === 403) {
    return new AuthError(
      provider,
      detail,
      cause !== undefined ? { cause } : undefined,
    );
  }
  if (status === 429) {
    return new AdapterError(provider, `${provider} rate-limited (HTTP 429): ${detail}`, {
      retryable: true,
      ...(cause !== undefined ? { cause } : {}),
    });
  }
  if (status >= 500) {
    return new AdapterError(
      provider,
      `${provider} transient failure (HTTP ${status}): ${detail}`,
      {
        retryable: true,
        ...(cause !== undefined ? { cause } : {}),
      },
    );
  }
  return new AdapterError(provider, `${provider} HTTP ${status}: ${detail}`, {
    retryable: false,
    ...(cause !== undefined ? { cause } : {}),
  });
}
