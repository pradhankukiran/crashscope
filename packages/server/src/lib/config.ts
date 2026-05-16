/**
 * Build a {@link CrashscopeConfig} from validated environment variables.
 *
 * Two-stage validation: {@link loadEnv} ensures every set env var is *shaped*
 * correctly; this function then enforces that the env vars *required for the
 * selected providers* are present, and surfaces a single coherent error when
 * they aren't.
 */
import type { CrashscopeConfig } from "@pradhankukiran/crashscope-core";
import { ConfigError } from "@pradhankukiran/crashscope-core";
import { loadEnv, type ServerEnv } from "./env.js";

/**
 * Collect the names of missing required env vars for the current providers
 * before throwing. This gives the API a deterministic, user-friendly list
 * instead of dying on the first one it notices.
 */
function checkRequired(
  env: ServerEnv,
  required: ReadonlyArray<keyof ServerEnv>,
): string[] {
  return required.filter((k) => env[k] === undefined || env[k] === "").map(
    (k) => String(k),
  );
}

/**
 * Translate `ERROR_PROVIDER` + its credentials into the `credentials` slot
 * `crashscopeConfigSchema` expects. Returns `null` plus the missing-var list
 * when required env vars are absent.
 */
function buildErrorCredentials(env: ServerEnv): {
  provider: CrashscopeConfig["errorProvider"];
  credentials: NonNullable<CrashscopeConfig["credentials"]>;
  missing: string[];
} {
  const provider = env.ERROR_PROVIDER;
  if (!provider) {
    return {
      provider: "sentry",
      credentials: {},
      missing: ["ERROR_PROVIDER"],
    };
  }
  switch (provider) {
    case "sentry": {
      const missing = checkRequired(env, [
        "SENTRY_TOKEN",
        "SENTRY_ORG",
        "SENTRY_PROJECT",
      ]);
      return {
        provider,
        credentials: missing.length
          ? {}
          : {
              sentry: {
                token: env.SENTRY_TOKEN as string,
                org: env.SENTRY_ORG as string,
                project: env.SENTRY_PROJECT as string,
              },
            },
        missing,
      };
    }
    case "rollbar": {
      // Rollbar's `project` slug is optional in the core schema, so only the
      // read token is strictly required.
      const missing = checkRequired(env, ["ROLLBAR_TOKEN"]);
      const creds: NonNullable<CrashscopeConfig["credentials"]>["rollbar"] = {
        readToken: env.ROLLBAR_TOKEN as string,
        ...(env.ROLLBAR_PROJECT ? { project: env.ROLLBAR_PROJECT } : {}),
      };
      return {
        provider,
        credentials: missing.length ? {} : { rollbar: creds },
        missing,
      };
    }
    case "bugsnag": {
      const missing = checkRequired(env, [
        "BUGSNAG_TOKEN",
        "BUGSNAG_ORGANIZATION_ID",
        "BUGSNAG_PROJECT_ID",
      ]);
      return {
        provider,
        credentials: missing.length
          ? {}
          : {
              bugsnag: {
                token: env.BUGSNAG_TOKEN as string,
                organizationId: env.BUGSNAG_ORGANIZATION_ID as string,
                projectId: env.BUGSNAG_PROJECT_ID as string,
              },
            },
        missing,
      };
    }
    case "honeybadger": {
      const missing = checkRequired(env, [
        "HONEYBADGER_TOKEN",
        "HONEYBADGER_PROJECT",
      ]);
      return {
        provider,
        credentials: missing.length
          ? {}
          : {
              honeybadger: {
                token: env.HONEYBADGER_TOKEN as string,
                projectId: env.HONEYBADGER_PROJECT as string,
              },
            },
        missing,
      };
    }
    default: {
      // Exhaustiveness check — if the enum grows, this will fail to compile.
      const exhaustive: never = provider;
      throw new ConfigError(`Unknown error provider: ${String(exhaustive)}`);
    }
  }
}

/**
 * Same shape as {@link buildErrorCredentials} but for session providers.
 */
function buildSessionCredentials(env: ServerEnv): {
  provider: CrashscopeConfig["sessionProvider"];
  credentials: NonNullable<CrashscopeConfig["credentials"]>;
  missing: string[];
} {
  const provider = env.SESSION_PROVIDER;
  if (!provider) {
    return {
      provider: "posthog",
      credentials: {},
      missing: ["SESSION_PROVIDER"],
    };
  }
  switch (provider) {
    case "posthog": {
      const missing = checkRequired(env, [
        "POSTHOG_API_KEY",
        "POSTHOG_PROJECT_ID",
      ]);
      const creds: NonNullable<CrashscopeConfig["credentials"]>["posthog"] = {
        apiKey: env.POSTHOG_API_KEY as string,
        projectId: env.POSTHOG_PROJECT_ID as string,
        ...(env.POSTHOG_HOST ? { host: env.POSTHOG_HOST } : {}),
      };
      return {
        provider,
        credentials: missing.length ? {} : { posthog: creds },
        missing,
      };
    }
    case "logrocket": {
      const missing = checkRequired(env, [
        "LOGROCKET_API_KEY",
        "LOGROCKET_APP_SLUG",
      ]);
      return {
        provider,
        credentials: missing.length
          ? {}
          : {
              logrocket: {
                apiKey: env.LOGROCKET_API_KEY as string,
                appSlug: env.LOGROCKET_APP_SLUG as string,
              },
            },
        missing,
      };
    }
    default: {
      const exhaustive: never = provider;
      throw new ConfigError(`Unknown session provider: ${String(exhaustive)}`);
    }
  }
}

/**
 * Build a fully-validated {@link CrashscopeConfig}.
 *
 * Server mode is API-key-only by design: the Claude Code subscription mode in
 * core requires `~/.claude` and a TTY-ish auth ceremony that doesn't exist
 * inside a Vercel function. We refuse to start triage without
 * `ANTHROPIC_API_KEY` and document the requirement here.
 *
 * Throws {@link ConfigError} with the aggregated list of missing env vars
 * when configuration is incomplete.
 */
export function buildConfig(): CrashscopeConfig {
  const env = loadEnv();

  const err = buildErrorCredentials(env);
  const sess = buildSessionCredentials(env);

  const missing: string[] = [];
  if (!env.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
  if (!env.CRASHSCOPE_API_TOKEN) missing.push("CRASHSCOPE_API_TOKEN");
  missing.push(...err.missing, ...sess.missing);

  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }

  // The `as` casts above guarantee these branches set the matching key; merge
  // them into the credentials object that `crashscopeConfigSchema` expects.
  const credentials: NonNullable<CrashscopeConfig["credentials"]> = {
    ...err.credentials,
    ...sess.credentials,
  };

  return {
    errorProvider: err.provider,
    sessionProvider: sess.provider,
    outputs: ["json"],
    credentials,
    anthropic: { apiKey: env.ANTHROPIC_API_KEY as string },
  };
}
