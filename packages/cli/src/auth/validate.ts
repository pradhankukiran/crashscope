/**
 * Lightweight live credential probes used by `crashscope init`.
 *
 * Each `validate*` function performs the smallest authenticated request that
 * a given provider exposes so the wizard can confirm a token works before
 * persisting it. The functions never throw on network failure — instead they
 * return a tagged `ValidationResult` so callers can branch on three states:
 *
 *   - `ok: true`              → credential is valid.
 *   - `ok: false, status`     → upstream returned an auth-style status (the
 *                                wizard re-prompts).
 *   - `ok: false, network: true` → the host was unreachable (the wizard
 *                                surfaces a warning but still lets the user
 *                                save the credential).
 *
 * Adapters in `@crashscope/core` already classify HTTP failures via
 * `classifyHttpFailure`, but those are tied to a fully-constructed adapter +
 * its richer normalisation contract. Re-using them here would pull in the
 * adapter constructor surface and mean a failed probe also touches the
 * normalisation pipeline. Keeping these helpers free-standing is simpler.
 */

import type {
  BugsnagCredentials,
  HoneybadgerCredentials,
  PosthogCredentials,
  RollbarCredentials,
  SentryCredentials,
} from "@crashscope/core";

/**
 * Default per-request timeout for credential probes. The wizard prompts the
 * user inline so we lean towards "fail fast" over "wait forever on a
 * misconfigured proxy" — a slow validator turns the init flow into mush.
 */
const PROBE_TIMEOUT_MS = 8_000;

export type ValidationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status?: number;
      readonly message: string;
      /** True when the failure looks like a network error, not an auth one. */
      readonly network?: boolean;
    };

/**
 * Wrap `fetch` with a timeout signal so a hanging server doesn't stall the
 * wizard. Returns the raw `Response` on success and a `null` along with a
 * synthetic error message on transport failure.
 */
async function probeFetch(
  url: string,
  init: RequestInit,
): Promise<
  | { ok: true; response: Response }
  | { ok: false; message: string; network: true }
> {
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal });
    return { ok: true, response };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message, network: true };
  }
}

/**
 * Translate a probe response into a `ValidationResult`.
 *
 * `okStatuses` is a small allowlist (200, 201, 204) of "credentials work"
 * responses; every other 2xx is suspicious enough that we'd rather surface it
 * as a soft failure than silently accept.
 */
function classifyProbe(
  response: Response,
  providerLabel: string,
): ValidationResult {
  if (response.ok) return { ok: true };
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      status: response.status,
      message: `${providerLabel} rejected the token (HTTP ${response.status}). Check the value and try again.`,
    };
  }
  return {
    ok: false,
    status: response.status,
    message: `${providerLabel} returned HTTP ${response.status}. The token may still be valid; you can retry or proceed.`,
  };
}

/**
 * Sentry: `GET /api/0/projects/{org}/{project}/` returns the project object
 * on success and 401/403 when the auth token is invalid for the project.
 */
export async function validateSentry(
  creds: SentryCredentials,
): Promise<ValidationResult> {
  const url = `https://sentry.io/api/0/projects/${encodeURIComponent(creds.org)}/${encodeURIComponent(creds.project)}/`;
  const probe = await probeFetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${creds.token}`, Accept: "application/json" },
  });
  if (!probe.ok) {
    return { ok: false, message: probe.message, network: true };
  }
  return classifyProbe(probe.response, "Sentry");
}

/**
 * Rollbar: when a project slug is known we can hit the per-project endpoint;
 * otherwise fall back to a 1-item items page which any read token can call.
 *
 * Rollbar's items endpoint requires `X-Rollbar-Access-Token` rather than an
 * `Authorization` header.
 */
export async function validateRollbar(
  creds: RollbarCredentials,
): Promise<ValidationResult> {
  const headers = {
    "X-Rollbar-Access-Token": creds.readToken,
    Accept: "application/json",
  };
  const url =
    creds.project !== undefined && creds.project.length > 0
      ? `https://api.rollbar.com/api/1/projects/${encodeURIComponent(creds.project)}/`
      : `https://api.rollbar.com/api/1/items?limit=1`;
  const probe = await probeFetch(url, { method: "GET", headers });
  if (!probe.ok) {
    return { ok: false, message: probe.message, network: true };
  }
  return classifyProbe(probe.response, "Rollbar");
}

/**
 * Bugsnag: `GET /projects/{projectId}` against the user-facing data API
 * surface. Their API is hosted at `api.bugsnag.com` and accepts the personal
 * auth token in the `Authorization: token <token>` header.
 */
export async function validateBugsnag(
  creds: BugsnagCredentials,
): Promise<ValidationResult> {
  const url = `https://api.bugsnag.com/projects/${encodeURIComponent(creds.projectId)}`;
  const probe = await probeFetch(url, {
    method: "GET",
    headers: {
      Authorization: `token ${creds.token}`,
      Accept: "application/json",
      "X-Version": "2",
    },
  });
  if (!probe.ok) {
    return { ok: false, message: probe.message, network: true };
  }
  return classifyProbe(probe.response, "Bugsnag");
}

/**
 * Honeybadger: `GET /v2/projects/{projectId}`. Honeybadger uses HTTP basic
 * auth with the token as the username and an empty password.
 */
export async function validateHoneybadger(
  creds: HoneybadgerCredentials,
): Promise<ValidationResult> {
  const url = `https://app.honeybadger.io/v2/projects/${encodeURIComponent(creds.projectId)}`;
  const basic = Buffer.from(`${creds.token}:`).toString("base64");
  const probe = await probeFetch(url, {
    method: "GET",
    headers: {
      Authorization: `Basic ${basic}`,
      Accept: "application/json",
    },
  });
  if (!probe.ok) {
    return { ok: false, message: probe.message, network: true };
  }
  return classifyProbe(probe.response, "Honeybadger");
}

/**
 * PostHog: `GET /api/projects/{projectId}/`. The host defaults to
 * `app.posthog.com` but self-hosters can override it.
 */
export async function validatePostHog(
  creds: PosthogCredentials,
): Promise<ValidationResult> {
  const baseHost =
    creds.host !== undefined && creds.host.length > 0
      ? creds.host.replace(/\/+$/, "")
      : "https://app.posthog.com";
  const url = `${baseHost}/api/projects/${encodeURIComponent(creds.projectId)}/`;
  const probe = await probeFetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${creds.apiKey}`,
      Accept: "application/json",
    },
  });
  if (!probe.ok) {
    return { ok: false, message: probe.message, network: true };
  }
  return classifyProbe(probe.response, "PostHog");
}

/**
 * Anthropic: hit `GET /v1/models` with the candidate key. This is the
 * cheapest authenticated call exposed by the API and avoids spending any
 * generation tokens.
 *
 * Anthropic responses use `x-api-key` for auth and require the
 * `anthropic-version` header.
 */
export async function validateAnthropic(
  apiKey: string,
): Promise<ValidationResult> {
  const probe = await probeFetch("https://api.anthropic.com/v1/models", {
    method: "GET",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      Accept: "application/json",
    },
  });
  if (!probe.ok) {
    return { ok: false, message: probe.message, network: true };
  }
  return classifyProbe(probe.response, "Anthropic");
}
