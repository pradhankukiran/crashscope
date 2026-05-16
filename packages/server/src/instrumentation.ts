/**
 * Next.js boot-time instrumentation hook.
 *
 * Surfaces env misconfiguration loudly at startup instead of waiting for the
 * first request to fail. The validation is intentionally inlined here so we
 * don't have to navigate the edge-vs-node bundling tradeoff: `@pradhankukiran/crashscope-core`
 * transitively pulls `node:os`/`node:fs`/`node:child_process` which the edge
 * runtime can't load, and any dynamic import of a richer validator either
 * blows up the edge build or gets dropped from the Next.js standalone output.
 *
 * We don't crash on failure: a partially-configured deploy should still come
 * up so request-time handlers can produce intelligible 500s instead of the
 * container crash-looping with no surface visible to the operator.
 */

interface EnvCheckResult {
  readonly ok: boolean;
  readonly missing: readonly string[];
  readonly warnings: readonly string[];
}

const ERROR_PROVIDER_REQUIREMENTS: Record<string, readonly string[]> = {
  sentry: ["SENTRY_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"],
  rollbar: ["ROLLBAR_TOKEN"],
  bugsnag: ["BUGSNAG_TOKEN", "BUGSNAG_ORGANIZATION_ID", "BUGSNAG_PROJECT_ID"],
  honeybadger: ["HONEYBADGER_TOKEN", "HONEYBADGER_PROJECT"],
};

const SESSION_PROVIDER_REQUIREMENTS: Record<string, readonly string[]> = {
  posthog: ["POSTHOG_API_KEY", "POSTHOG_PROJECT_ID"],
  logrocket: ["LOGROCKET_API_KEY", "LOGROCKET_APP_SLUG"],
};

function present(name: string): boolean {
  const v = process.env[name];
  return typeof v === "string" && v.length > 0;
}

function checkBootEnv(): EnvCheckResult {
  const missing: string[] = [];
  const warnings: string[] = [];

  // Anthropic + REST token are required for the env-driven (GET) surface but
  // the public POST demo brings its own. Treat as warnings, not errors.
  if (!present("ANTHROPIC_API_KEY")) {
    warnings.push(
      "ANTHROPIC_API_KEY not set: GET /api/triage and Slack bot disabled (public POST demo still works).",
    );
  }
  if (!present("CRASHSCOPE_API_TOKEN")) {
    warnings.push(
      "CRASHSCOPE_API_TOKEN not set: GET /api/triage will reject all requests.",
    );
  }

  const errorProvider = process.env["ERROR_PROVIDER"];
  if (errorProvider) {
    const required = ERROR_PROVIDER_REQUIREMENTS[errorProvider];
    if (!required) {
      missing.push(`ERROR_PROVIDER=${errorProvider} is not a recognised provider`);
    } else {
      for (const name of required) {
        if (!present(name)) missing.push(name);
      }
    }
  }

  const sessionProvider = process.env["SESSION_PROVIDER"];
  if (sessionProvider) {
    const required = SESSION_PROVIDER_REQUIREMENTS[sessionProvider];
    if (!required) {
      missing.push(
        `SESSION_PROVIDER=${sessionProvider} is not a recognised provider`,
      );
    } else {
      for (const name of required) {
        if (!present(name)) missing.push(name);
      }
    }
  }

  return { ok: missing.length === 0, missing, warnings };
}

export function register(): void {
  if (process.env["NEXT_RUNTIME"] !== "nodejs") return;
  const result = checkBootEnv();
  for (const w of result.warnings) {
    console.warn(`[crashscope] ${w}`);
  }
  if (result.ok) {
    console.info("[crashscope] env validation ok at boot");
  } else {
    console.error(
      `[crashscope] env validation issues at boot: missing=${result.missing.join(",")}`,
    );
  }
}
