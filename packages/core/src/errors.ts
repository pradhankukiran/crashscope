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
 */
export class AdapterError extends CrashscopeError {
  public readonly code = "ADAPTER_ERROR";
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
