/**
 * Zod-validated environment-variable loader.
 *
 * The schema intentionally accepts the full union of provider env vars: only
 * the subset belonging to the *selected* provider is required, and that
 * narrowing happens in {@link ./config.ts | buildConfig()}. Doing it in two
 * stages keeps this module reusable from tests and from non-API call sites
 * (e.g. health checks) without forcing every env var to be present.
 *
 * Errors are surfaced via {@link import("@pradhankukiran/crashscope-core").ConfigError} so
 * API handlers can render a stable 500 with a helpful `missing` list.
 */
import { z } from "zod";
import { ConfigError } from "@pradhankukiran/crashscope-core";

/** Recognised error-tracker providers. Mirrors `@pradhankukiran/crashscope-core`'s enum. */
const errorProviderEnum = z.enum([
  "sentry",
  "rollbar",
  "bugsnag",
  "honeybadger",
]);

/** Recognised session/replay providers. Mirrors `@pradhankukiran/crashscope-core`'s enum. */
const sessionProviderEnum = z.enum(["posthog", "logrocket"]);

/**
 * The "raw" env shape. Every field is optional at this stage because callers
 * may only need the subset corresponding to their selected provider. Required-
 * ness is enforced by {@link buildConfig}.
 *
 * `z.string().min(1)` rather than `z.string()` so empty-string env vars (which
 * shells silently produce when the value is unset) fail validation instead of
 * masquerading as "set".
 */
const envSchema = z.object({
  // Anthropic
  ANTHROPIC_API_KEY: z.string().min(1).optional(),

  // API auth token clients must present to /api/triage.
  CRASHSCOPE_API_TOKEN: z.string().min(1).optional(),

  // Provider selectors.
  ERROR_PROVIDER: errorProviderEnum.optional(),
  SESSION_PROVIDER: sessionProviderEnum.optional(),

  // Sentry
  SENTRY_TOKEN: z.string().min(1).optional(),
  SENTRY_ORG: z.string().min(1).optional(),
  SENTRY_PROJECT: z.string().min(1).optional(),

  // Rollbar
  ROLLBAR_TOKEN: z.string().min(1).optional(),
  ROLLBAR_PROJECT: z.string().min(1).optional(),

  // Bugsnag
  BUGSNAG_TOKEN: z.string().min(1).optional(),
  BUGSNAG_ORGANIZATION_ID: z.string().min(1).optional(),
  BUGSNAG_PROJECT_ID: z.string().min(1).optional(),

  // Honeybadger
  HONEYBADGER_TOKEN: z.string().min(1).optional(),
  HONEYBADGER_PROJECT: z.string().min(1).optional(),

  // PostHog
  POSTHOG_API_KEY: z.string().min(1).optional(),
  POSTHOG_PROJECT_ID: z.string().min(1).optional(),
  POSTHOG_HOST: z.string().url().optional(),

  // LogRocket
  LOGROCKET_API_KEY: z.string().min(1).optional(),
  LOGROCKET_APP_SLUG: z.string().min(1).optional(),

  // Slack
  SLACK_SIGNING_SECRET: z.string().min(1).optional(),
  SLACK_BOT_TOKEN: z.string().min(1).optional(),

  // Standard runtime metadata used by /api/health.
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .optional()
    .default("development"),
  npm_package_version: z.string().optional(),
});

/** Validated env-var bag. */
export type ServerEnv = z.infer<typeof envSchema>;

/**
 * Parse `process.env` once and memoize the result.
 *
 * We never throw on optional fields here — the only failure mode is a *bad*
 * value (e.g. malformed URL). Missing-required-for-this-provider checks
 * happen in {@link ./config.ts | buildConfig}.
 */
let cachedEnv: ServerEnv | null = null;

export function loadEnv(): ServerEnv {
  if (cachedEnv !== null) return cachedEnv;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new ConfigError(`Invalid environment configuration: ${issues}`);
  }
  cachedEnv = parsed.data;
  return cachedEnv;
}

/**
 * Test-only escape hatch — reset the memoized env so unit tests can mutate
 * `process.env` between cases. Production code should never call this.
 */
export function __resetEnvCacheForTests(): void {
  cachedEnv = null;
}
