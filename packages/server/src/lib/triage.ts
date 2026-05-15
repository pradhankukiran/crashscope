/**
 * Core triage pipeline used by the REST API and Slack bot.
 *
 * Flow:
 *   1. Build {@link CrashscopeConfig} from env.
 *   2. Resolve Anthropic auth (server mode is API-key-only).
 *   3. Instantiate the selected error + session adapters.
 *   4. Fetch recent errors; for each error with a sample user, fetch the
 *      nearest session.
 *   5. Pass the joined batch to `investigate()` from `@crashscope/core/agent`.
 *   6. Assemble + return a {@link TriageReport}.
 *
 * Failures inside individual adapter calls or per-issue investigations do not
 * bring the whole report down — `investigate()` already reports per-issue
 * failures as a low-confidence finding. Session fetches that throw degrade
 * gracefully to "no session" (replay-not-available isn't an error condition).
 */
import {
  AuthError,
  ConfigError,
  type CrashscopeConfig,
  type NormalizedError,
  type NormalizedSession,
  type TriageIssue,
  type TriageReport,
  type TriageSummary,
} from "@crashscope/core";
import { investigate, resolveAnthropicAuth } from "@crashscope/core/agent";
import type { AuthResolution } from "@crashscope/core/agent";
import {
  BugsnagAdapter,
  HoneybadgerAdapter,
  RollbarAdapter,
  SentryAdapter,
} from "@crashscope/core/adapters/errors";
import {
  LogRocketAdapter,
  PostHogAdapter,
} from "@crashscope/core/adapters/sessions";
import type {
  ErrorAdapter,
  FetchRecentOptions,
  SessionAdapter,
} from "@crashscope/core";
import { buildConfig } from "./config.js";

/**
 * Options accepted by {@link runTriage}.
 *
 * `since` is a human-readable window keyword (see {@link parseSinceWindow}).
 * `severities` filters at the adapter level — when omitted the adapter returns
 * issues of all severities.
 */
export interface TriageOptions {
  /** Window keyword: `1h`, `6h`, `24h`, `7d`, `14d`, `30d`. */
  since: string;
  /** Maximum issues to triage (1-100). */
  limit: number;
  /** Optional severity filter. */
  severities?: NormalizedError["severity"][];
  /** Cancellation signal forwarded to the agent. */
  signal?: AbortSignal;
}

/**
 * Map a window keyword to a Date in the past. We intentionally restrict to a
 * small set of values rather than parsing arbitrary `ms`-style strings: the
 * REST API contract documents these exact values and bounding the input keeps
 * adapter behavior predictable.
 */
const WINDOWS = {
  "1h": 1 * 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "14d": 14 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
} as const satisfies Record<string, number>;

export type SinceKeyword = keyof typeof WINDOWS;

export function isSinceKeyword(value: string): value is SinceKeyword {
  return Object.prototype.hasOwnProperty.call(WINDOWS, value);
}

export function parseSinceWindow(keyword: string): {
  since: Date;
  label: string;
} {
  if (!isSinceKeyword(keyword)) {
    throw new ConfigError(
      `Invalid 'since' window: ${keyword}. Use one of: ${Object.keys(WINDOWS).join(", ")}.`,
    );
  }
  const ms = WINDOWS[keyword];
  return {
    since: new Date(Date.now() - ms),
    label: `last ${keyword}`,
  };
}

/**
 * Instantiate the configured error adapter.
 *
 * The {@link CrashscopeConfig} schema guarantees that the matching credentials
 * slot is populated, but we still narrow at runtime so this function stays
 * defensive if config is built from another path in the future.
 */
function makeErrorAdapter(cfg: CrashscopeConfig): ErrorAdapter {
  switch (cfg.errorProvider) {
    case "sentry": {
      const c = cfg.credentials.sentry;
      if (!c) throw new ConfigError("sentry credentials missing");
      return new SentryAdapter({
        token: c.token,
        org: c.org,
        project: c.project,
      });
    }
    case "rollbar": {
      const c = cfg.credentials.rollbar;
      if (!c) throw new ConfigError("rollbar credentials missing");
      return new RollbarAdapter({
        readToken: c.readToken,
        ...(c.project ? { project: c.project } : {}),
      });
    }
    case "bugsnag": {
      const c = cfg.credentials.bugsnag;
      if (!c) throw new ConfigError("bugsnag credentials missing");
      return new BugsnagAdapter({
        token: c.token,
        organizationId: c.organizationId,
        projectId: c.projectId,
      });
    }
    case "honeybadger": {
      const c = cfg.credentials.honeybadger;
      if (!c) throw new ConfigError("honeybadger credentials missing");
      return new HoneybadgerAdapter({
        token: c.token,
        projectId: c.projectId,
      });
    }
    default: {
      const exhaustive: never = cfg.errorProvider;
      throw new ConfigError(`Unknown error provider: ${String(exhaustive)}`);
    }
  }
}

/** Instantiate the configured session adapter. */
function makeSessionAdapter(cfg: CrashscopeConfig): SessionAdapter {
  switch (cfg.sessionProvider) {
    case "posthog": {
      const c = cfg.credentials.posthog;
      if (!c) throw new ConfigError("posthog credentials missing");
      return new PostHogAdapter({
        apiKey: c.apiKey,
        projectId: c.projectId,
        ...(c.host ? { host: c.host } : {}),
      });
    }
    case "logrocket": {
      const c = cfg.credentials.logrocket;
      if (!c) throw new ConfigError("logrocket credentials missing");
      return new LogRocketAdapter({
        apiKey: c.apiKey,
        appSlug: c.appSlug,
      });
    }
    default: {
      const exhaustive: never = cfg.sessionProvider;
      throw new ConfigError(`Unknown session provider: ${String(exhaustive)}`);
    }
  }
}

/**
 * For each error, attempt to fetch a session for its first sample user. Errors
 * with no sample users get a `null` session. Adapter exceptions degrade to
 * `null` rather than failing the whole report: a missing replay is normal.
 */
async function joinSessions(
  errors: NormalizedError[],
  sessionAdapter: SessionAdapter,
): Promise<Map<string, NormalizedSession | null>> {
  const out = new Map<string, NormalizedSession | null>();
  await Promise.all(
    errors.map(async (e) => {
      const userId = e.sampleUserIds[0];
      if (!userId) {
        out.set(e.id, null);
        return;
      }
      try {
        const session = await sessionAdapter.fetchForUser({
          userId,
          around: new Date(e.lastSeen),
        });
        out.set(e.id, session);
      } catch {
        // Treat session-fetch failures as "no session" — the triage report is
        // still useful without replay context.
        out.set(e.id, null);
      }
    }),
  );
  return out;
}

/** Tally severities into a {@link TriageSummary} keyed by confidence band. */
function buildSummary(issues: TriageIssue[]): TriageSummary {
  const summary: TriageSummary = { high: 0, med: 0, low: 0, total: issues.length };
  for (const i of issues) summary[i.confidence] += 1;
  return summary;
}

/**
 * Run the full triage pipeline.
 *
 * Throws on configuration or auth errors so the calling route can map them to
 * the correct HTTP status. Per-issue failures are absorbed into the report.
 */
export async function runTriage(opts: TriageOptions): Promise<TriageReport> {
  const startedAt = Date.now();
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit)));
  const window = parseSinceWindow(opts.since);

  const config = buildConfig();

  // Server-mode hard requirement: we will not silently fall through to the
  // Claude Code subscription path inside a serverless function.
  if (!config.anthropic?.apiKey) {
    throw new AuthError(
      "anthropic",
      "Server mode requires ANTHROPIC_API_KEY. The Claude Code subscription path is not supported here.",
    );
  }
  const auth: AuthResolution = await resolveAnthropicAuth(config.anthropic);
  if (auth.mode !== "api-key") {
    throw new AuthError(
      "anthropic",
      "Server mode requires Anthropic API key authentication.",
    );
  }

  const errorAdapter = makeErrorAdapter(config);
  const sessionAdapter = makeSessionAdapter(config);

  const fetchOpts: FetchRecentOptions = {
    since: window.since,
    limit,
    ...(opts.severities && opts.severities.length > 0
      ? { severities: opts.severities }
      : {}),
  };
  const errors = await errorAdapter.fetchRecent(fetchOpts);

  const sessions = await joinSessions(errors, sessionAdapter);

  const issues = await investigate({
    errors,
    sessions,
    auth,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  return {
    generatedAt: new Date().toISOString(),
    window: window.label,
    summary: buildSummary(issues),
    issues,
    meta: {
      errorProvider: config.errorProvider,
      sessionProvider: config.sessionProvider,
      durationMs: Date.now() - startedAt,
    },
  };
}
