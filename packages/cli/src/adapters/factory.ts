import {
  ConfigError,
  type CrashscopeConfig,
  type ErrorAdapter,
  type SessionAdapter,
} from "@pradhankukiran/crashscope-core";
import {
  BugsnagAdapter,
  HoneybadgerAdapter,
  RollbarAdapter,
  SentryAdapter,
} from "@pradhankukiran/crashscope-core/adapters/errors";
import {
  LogRocketAdapter,
  PostHogAdapter,
} from "@pradhankukiran/crashscope-core/adapters/sessions";

/**
 * Construct the configured error-tracker adapter.
 *
 * Throws {@link ConfigError} when the required credential block is missing.
 * The schema validation on {@link CrashscopeConfig} should already prevent
 * this in practice, but we re-check here so a hand-edited config never
 * tunnels a `TypeError` from the adapter constructor.
 */
export function createErrorAdapter(config: CrashscopeConfig): ErrorAdapter {
  const provider = config.errorProvider;
  const creds = config.credentials;
  switch (provider) {
    case "sentry": {
      const c = creds.sentry;
      if (!c)
        throw new ConfigError(
          "Sentry credentials missing from config.credentials.sentry.",
        );
      return new SentryAdapter({
        token: c.token,
        org: c.org,
        project: c.project,
      });
    }
    case "rollbar": {
      const c = creds.rollbar;
      if (!c)
        throw new ConfigError(
          "Rollbar credentials missing from config.credentials.rollbar.",
        );
      // RollbarAdapter accepts `project` as an optional field; only forward
      // it when set so the strict optional-property check stays happy.
      return new RollbarAdapter(
        c.project !== undefined
          ? { readToken: c.readToken, project: c.project }
          : { readToken: c.readToken },
      );
    }
    case "bugsnag": {
      const c = creds.bugsnag;
      if (!c)
        throw new ConfigError(
          "Bugsnag credentials missing from config.credentials.bugsnag.",
        );
      return new BugsnagAdapter({
        token: c.token,
        organizationId: c.organizationId,
        projectId: c.projectId,
      });
    }
    case "honeybadger": {
      const c = creds.honeybadger;
      if (!c)
        throw new ConfigError(
          "Honeybadger credentials missing from config.credentials.honeybadger.",
        );
      return new HoneybadgerAdapter({
        token: c.token,
        projectId: c.projectId,
      });
    }
    default: {
      // Exhaustiveness check — TS will flag any missing case.
      const _exhaustive: never = provider;
      throw new ConfigError(`Unknown errorProvider: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Construct the configured session-replay adapter.
 *
 * See {@link createErrorAdapter} — the same defensive recheck applies here.
 */
export function createSessionAdapter(config: CrashscopeConfig): SessionAdapter {
  const provider = config.sessionProvider;
  const creds = config.credentials;
  switch (provider) {
    case "posthog": {
      const c = creds.posthog;
      if (!c)
        throw new ConfigError(
          "PostHog credentials missing from config.credentials.posthog.",
        );
      // `host` is optional on the adapter; preserve the strict-optional rule
      // by only forwarding when present.
      return new PostHogAdapter(
        c.host !== undefined
          ? { apiKey: c.apiKey, projectId: c.projectId, host: c.host }
          : { apiKey: c.apiKey, projectId: c.projectId },
      );
    }
    case "logrocket": {
      const c = creds.logrocket;
      if (!c)
        throw new ConfigError(
          "LogRocket credentials missing from config.credentials.logrocket.",
        );
      // LogRocket's URL scheme is `/v1/orgs/{orgSlug}/apps/{appSlug}` and
      // the adapter accepts an explicit `orgSlug` field. The config schema
      // doesn't yet have a dedicated slot for it, so we forward the appSlug
      // as a stand-in — sites whose org and app slugs differ should set
      // `appSlug` to `"<org>/<app>"`. The LogRocket adapter is being
      // rewritten in core; once the schema gains an `orgSlug` field this
      // can be threaded through cleanly.
      return new LogRocketAdapter({
        apiKey: c.apiKey,
        orgSlug: c.appSlug,
        appSlug: c.appSlug,
      });
    }
    default: {
      const _exhaustive: never = provider;
      throw new ConfigError(`Unknown sessionProvider: ${String(_exhaustive)}`);
    }
  }
}
