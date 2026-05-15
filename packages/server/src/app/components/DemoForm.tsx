"use client";

/**
 * DemoForm — the in-page triage form that powers the public landing-page
 * demo.
 *
 * Behaviour:
 *  - All state lives in React + localStorage (`crashscope-demo-config`).
 *  - On submit, POSTs to `/api/triage` (same-origin, no Authorization header).
 *  - While running, disables the submit button and reports elapsed time to the
 *    parent via `onRunStateChange`.
 *  - On 200, hands the parsed `TriageReport` to `onResult`.
 *  - On any error (network, schema, server), calls `onError(message)`.
 *
 * Credentials are stored in the browser only. The notice under the form
 * documents this clearly. We deliberately persist the Anthropic key too —
 * the test app already does this for provider keys; expecting visitors to
 * paste it on every run would be hostile UX.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TriageReport } from "@crashscope/core";

// ----- Types ---------------------------------------------------------------

type ErrorProvider = "sentry" | "rollbar" | "bugsnag" | "honeybadger";
type SessionProvider = "posthog" | "logrocket";
type SinceWindow = "1h" | "6h" | "24h" | "7d" | "14d" | "30d";

interface SentryCreds {
  token: string;
  org: string;
  project: string;
}
interface RollbarCreds {
  readToken: string;
  project: string;
}
interface BugsnagCreds {
  token: string;
  organizationId: string;
  projectId: string;
}
interface HoneybadgerCreds {
  token: string;
  projectId: string;
}
interface PostHogCreds {
  apiKey: string;
  projectId: string;
  host: string;
}
interface LogRocketCreds {
  apiKey: string;
  appSlug: string;
}

interface FormState {
  anthropicApiKey: string;
  errorProvider: ErrorProvider;
  sessionProvider: SessionProvider;
  sentry: SentryCreds;
  rollbar: RollbarCreds;
  bugsnag: BugsnagCreds;
  honeybadger: HoneybadgerCreds;
  posthog: PostHogCreds;
  logrocket: LogRocketCreds;
  since: SinceWindow;
  limit: number;
}

export interface DemoFormProps {
  onResult: (report: TriageReport) => void;
  onError: (message: string) => void;
  onRunStateChange?: (state: { running: boolean; elapsedMs: number }) => void;
}

// ----- Defaults + persistence ---------------------------------------------

const STORAGE_KEY = "crashscope-demo-config";

const DEFAULT_STATE: FormState = {
  anthropicApiKey: "",
  errorProvider: "sentry",
  sessionProvider: "posthog",
  sentry: { token: "", org: "", project: "" },
  rollbar: { readToken: "", project: "" },
  bugsnag: { token: "", organizationId: "", projectId: "" },
  honeybadger: { token: "", projectId: "" },
  posthog: {
    apiKey: "",
    projectId: "",
    host: "https://us.i.posthog.com",
  },
  logrocket: { apiKey: "", appSlug: "" },
  since: "24h",
  limit: 5,
};

/**
 * Defensively merge persisted state into defaults: persisted shape may be
 * older / partial across deploys. We only copy known keys.
 */
function mergeState(
  defaults: FormState,
  stored: Partial<FormState> | null,
): FormState {
  if (!stored) return defaults;
  return {
    anthropicApiKey:
      typeof stored.anthropicApiKey === "string"
        ? stored.anthropicApiKey
        : defaults.anthropicApiKey,
    errorProvider:
      stored.errorProvider && isErrorProvider(stored.errorProvider)
        ? stored.errorProvider
        : defaults.errorProvider,
    sessionProvider:
      stored.sessionProvider && isSessionProvider(stored.sessionProvider)
        ? stored.sessionProvider
        : defaults.sessionProvider,
    sentry: { ...defaults.sentry, ...(stored.sentry ?? {}) },
    rollbar: { ...defaults.rollbar, ...(stored.rollbar ?? {}) },
    bugsnag: { ...defaults.bugsnag, ...(stored.bugsnag ?? {}) },
    honeybadger: { ...defaults.honeybadger, ...(stored.honeybadger ?? {}) },
    posthog: { ...defaults.posthog, ...(stored.posthog ?? {}) },
    logrocket: { ...defaults.logrocket, ...(stored.logrocket ?? {}) },
    since: stored.since && isSince(stored.since) ? stored.since : defaults.since,
    limit:
      typeof stored.limit === "number" && stored.limit >= 1 && stored.limit <= 25
        ? Math.floor(stored.limit)
        : defaults.limit,
  };
}

function isErrorProvider(v: string): v is ErrorProvider {
  return (
    v === "sentry" || v === "rollbar" || v === "bugsnag" || v === "honeybadger"
  );
}
function isSessionProvider(v: string): v is SessionProvider {
  return v === "posthog" || v === "logrocket";
}
function isSince(v: string): v is SinceWindow {
  return ["1h", "6h", "24h", "7d", "14d", "30d"].includes(v);
}

// ----- Component ----------------------------------------------------------

export function DemoForm({
  onResult,
  onError,
  onRunStateChange,
}: DemoFormProps): JSX.Element {
  const [state, setState] = useState<FormState>(DEFAULT_STATE);
  const [hydrated, setHydrated] = useState(false);
  const [running, setRunning] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const tickRef = useRef<number | null>(null);

  // Hydrate from localStorage once on mount.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<FormState>;
        setState((prev) => mergeState(prev, parsed));
      }
    } catch {
      // Ignore — corrupt storage just means we use defaults.
    }
    setHydrated(true);
  }, []);

  // Persist on every change *after* hydration so we don't immediately
  // overwrite stored state with defaults on first render.
  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Quota or privacy mode — silently ignore.
    }
  }, [hydrated, state]);

  // Emit run-state changes (debounced trivially via tick).
  useEffect(() => {
    onRunStateChange?.({ running, elapsedMs });
  }, [onRunStateChange, running, elapsedMs]);

  // Elapsed-time ticker.
  useEffect(() => {
    if (!running) {
      if (tickRef.current !== null) {
        window.clearInterval(tickRef.current);
        tickRef.current = null;
      }
      return;
    }
    const start = Date.now();
    setElapsedMs(0);
    tickRef.current = window.setInterval(() => {
      setElapsedMs(Date.now() - start);
    }, 250);
    return () => {
      if (tickRef.current !== null) {
        window.clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };
  }, [running]);

  // ----- Validation -------------------------------------------------------

  const validationError = useMemo<string | null>(() => {
    if (!state.anthropicApiKey.trim()) return "Anthropic API key is required.";
    switch (state.errorProvider) {
      case "sentry": {
        const c = state.sentry;
        if (!c.token || !c.org || !c.project)
          return "Fill in Sentry token, org, and project.";
        break;
      }
      case "rollbar": {
        if (!state.rollbar.readToken)
          return "Fill in Rollbar read token.";
        break;
      }
      case "bugsnag": {
        const c = state.bugsnag;
        if (!c.token || !c.organizationId || !c.projectId)
          return "Fill in Bugsnag token, organization id, and project id.";
        break;
      }
      case "honeybadger": {
        const c = state.honeybadger;
        if (!c.token || !c.projectId)
          return "Fill in Honeybadger token and project id.";
        break;
      }
    }
    switch (state.sessionProvider) {
      case "posthog": {
        const c = state.posthog;
        if (!c.apiKey || !c.projectId)
          return "Fill in PostHog API key and project id.";
        break;
      }
      case "logrocket": {
        const c = state.logrocket;
        if (!c.apiKey || !c.appSlug)
          return "Fill in LogRocket API key and app slug.";
        break;
      }
    }
    return null;
  }, [state]);

  // ----- Submit -----------------------------------------------------------

  const handleSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (validationError) {
        setFormError(validationError);
        return;
      }
      setFormError(null);

      const credentials: Record<string, unknown> = {};
      switch (state.errorProvider) {
        case "sentry":
          credentials["sentry"] = state.sentry;
          break;
        case "rollbar":
          credentials["rollbar"] = state.rollbar.project.trim()
            ? state.rollbar
            : { readToken: state.rollbar.readToken };
          break;
        case "bugsnag":
          credentials["bugsnag"] = state.bugsnag;
          break;
        case "honeybadger":
          credentials["honeybadger"] = state.honeybadger;
          break;
      }
      switch (state.sessionProvider) {
        case "posthog":
          credentials["posthog"] = {
            apiKey: state.posthog.apiKey,
            projectId: state.posthog.projectId,
            ...(state.posthog.host ? { host: state.posthog.host } : {}),
          };
          break;
        case "logrocket":
          credentials["logrocket"] = state.logrocket;
          break;
      }

      const body = {
        errorProvider: state.errorProvider,
        sessionProvider: state.sessionProvider,
        credentials,
        anthropic: { apiKey: state.anthropicApiKey },
        opts: {
          since: state.since,
          limit: state.limit,
        },
      };

      setRunning(true);
      try {
        const res = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        let payload: unknown = null;
        try {
          payload = JSON.parse(text);
        } catch {
          // Non-JSON body — surface raw text.
        }
        if (!res.ok) {
          const message =
            payload && typeof payload === "object" && payload !== null &&
            "message" in payload && typeof (payload as { message: unknown }).message === "string"
              ? (payload as { message: string }).message
              : `Request failed with status ${res.status}.`;
          setFormError(message);
          onError(message);
          return;
        }
        onResult(payload as TriageReport);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Network error.";
        setFormError(message);
        onError(message);
      } finally {
        setRunning(false);
      }
    },
    [onError, onResult, state, validationError],
  );

  // ----- Render -----------------------------------------------------------

  const elapsedSeconds = (elapsedMs / 1000).toFixed(1);
  const submitDisabled = running || validationError !== null;

  return (
    <form
      onSubmit={handleSubmit}
      className="grid grid-cols-1 md:grid-cols-2 gap-6"
    >
      {/* AI section */}
      <Section title="AI">
        <Field label="Anthropic API Key" hint="sk-ant-…">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={state.anthropicApiKey}
            onChange={(e) =>
              setState((s) => ({ ...s, anthropicApiKey: e.target.value }))
            }
            className={inputCls + " font-mono"}
            placeholder="sk-ant-…"
          />
        </Field>
      </Section>

      {/* Run options */}
      <Section title="Run options">
        <Field label="Window">
          <select
            className={selectCls}
            value={state.since}
            onChange={(e) =>
              setState((s) => ({ ...s, since: e.target.value as SinceWindow }))
            }
          >
            <option value="1h">Last 1 hour</option>
            <option value="6h">Last 6 hours</option>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="14d">Last 14 days</option>
            <option value="30d">Last 30 days</option>
          </select>
        </Field>
        <Field label="Limit (1–25)">
          <input
            type="number"
            min={1}
            max={25}
            value={state.limit}
            onChange={(e) => {
              const n = Number(e.target.value);
              setState((s) => ({
                ...s,
                limit: Number.isFinite(n)
                  ? Math.min(25, Math.max(1, Math.floor(n)))
                  : s.limit,
              }));
            }}
            className={inputCls}
          />
        </Field>
      </Section>

      {/* Error provider */}
      <Section title="Error provider">
        <Field label="Provider">
          <select
            className={selectCls}
            value={state.errorProvider}
            onChange={(e) =>
              setState((s) => ({
                ...s,
                errorProvider: e.target.value as ErrorProvider,
              }))
            }
          >
            <option value="sentry">Sentry</option>
            <option value="rollbar">Rollbar</option>
            <option value="bugsnag">Bugsnag</option>
            <option value="honeybadger">Honeybadger</option>
          </select>
        </Field>
        {state.errorProvider === "sentry" && (
          <>
            <Field label="Token">
              <input
                type="password"
                autoComplete="off"
                value={state.sentry.token}
                onChange={(e) =>
                  setState((s) => ({
                    ...s,
                    sentry: { ...s.sentry, token: e.target.value },
                  }))
                }
                className={inputCls + " font-mono"}
              />
            </Field>
            <Field label="Org">
              <input
                value={state.sentry.org}
                onChange={(e) =>
                  setState((s) => ({
                    ...s,
                    sentry: { ...s.sentry, org: e.target.value },
                  }))
                }
                className={inputCls + " font-mono"}
              />
            </Field>
            <Field label="Project">
              <input
                value={state.sentry.project}
                onChange={(e) =>
                  setState((s) => ({
                    ...s,
                    sentry: { ...s.sentry, project: e.target.value },
                  }))
                }
                className={inputCls + " font-mono"}
              />
            </Field>
          </>
        )}
        {state.errorProvider === "rollbar" && (
          <>
            <Field label="Read token">
              <input
                type="password"
                autoComplete="off"
                value={state.rollbar.readToken}
                onChange={(e) =>
                  setState((s) => ({
                    ...s,
                    rollbar: { ...s.rollbar, readToken: e.target.value },
                  }))
                }
                className={inputCls + " font-mono"}
              />
            </Field>
            <Field label="Project (optional)">
              <input
                value={state.rollbar.project}
                onChange={(e) =>
                  setState((s) => ({
                    ...s,
                    rollbar: { ...s.rollbar, project: e.target.value },
                  }))
                }
                className={inputCls + " font-mono"}
              />
            </Field>
          </>
        )}
        {state.errorProvider === "bugsnag" && (
          <>
            <Field label="Token">
              <input
                type="password"
                autoComplete="off"
                value={state.bugsnag.token}
                onChange={(e) =>
                  setState((s) => ({
                    ...s,
                    bugsnag: { ...s.bugsnag, token: e.target.value },
                  }))
                }
                className={inputCls + " font-mono"}
              />
            </Field>
            <Field label="Organization id">
              <input
                value={state.bugsnag.organizationId}
                onChange={(e) =>
                  setState((s) => ({
                    ...s,
                    bugsnag: {
                      ...s.bugsnag,
                      organizationId: e.target.value,
                    },
                  }))
                }
                className={inputCls + " font-mono"}
              />
            </Field>
            <Field label="Project id">
              <input
                value={state.bugsnag.projectId}
                onChange={(e) =>
                  setState((s) => ({
                    ...s,
                    bugsnag: { ...s.bugsnag, projectId: e.target.value },
                  }))
                }
                className={inputCls + " font-mono"}
              />
            </Field>
          </>
        )}
        {state.errorProvider === "honeybadger" && (
          <>
            <Field label="Token">
              <input
                type="password"
                autoComplete="off"
                value={state.honeybadger.token}
                onChange={(e) =>
                  setState((s) => ({
                    ...s,
                    honeybadger: {
                      ...s.honeybadger,
                      token: e.target.value,
                    },
                  }))
                }
                className={inputCls + " font-mono"}
              />
            </Field>
            <Field label="Project id">
              <input
                value={state.honeybadger.projectId}
                onChange={(e) =>
                  setState((s) => ({
                    ...s,
                    honeybadger: {
                      ...s.honeybadger,
                      projectId: e.target.value,
                    },
                  }))
                }
                className={inputCls + " font-mono"}
              />
            </Field>
          </>
        )}
      </Section>

      {/* Session provider */}
      <Section title="Session provider">
        <Field label="Provider">
          <select
            className={selectCls}
            value={state.sessionProvider}
            onChange={(e) =>
              setState((s) => ({
                ...s,
                sessionProvider: e.target.value as SessionProvider,
              }))
            }
          >
            <option value="posthog">PostHog</option>
            <option value="logrocket">LogRocket</option>
          </select>
        </Field>
        {state.sessionProvider === "posthog" && (
          <>
            <Field label="API key">
              <input
                type="password"
                autoComplete="off"
                value={state.posthog.apiKey}
                onChange={(e) =>
                  setState((s) => ({
                    ...s,
                    posthog: { ...s.posthog, apiKey: e.target.value },
                  }))
                }
                className={inputCls + " font-mono"}
              />
            </Field>
            <Field label="Project id">
              <input
                value={state.posthog.projectId}
                onChange={(e) =>
                  setState((s) => ({
                    ...s,
                    posthog: { ...s.posthog, projectId: e.target.value },
                  }))
                }
                className={inputCls + " font-mono"}
              />
            </Field>
            <Field label="Host" hint="EU: https://eu.i.posthog.com">
              <input
                value={state.posthog.host}
                onChange={(e) =>
                  setState((s) => ({
                    ...s,
                    posthog: { ...s.posthog, host: e.target.value },
                  }))
                }
                className={inputCls + " font-mono"}
              />
            </Field>
          </>
        )}
        {state.sessionProvider === "logrocket" && (
          <>
            <Field label="API key">
              <input
                type="password"
                autoComplete="off"
                value={state.logrocket.apiKey}
                onChange={(e) =>
                  setState((s) => ({
                    ...s,
                    logrocket: { ...s.logrocket, apiKey: e.target.value },
                  }))
                }
                className={inputCls + " font-mono"}
              />
            </Field>
            <Field label="App slug">
              <input
                value={state.logrocket.appSlug}
                onChange={(e) =>
                  setState((s) => ({
                    ...s,
                    logrocket: { ...s.logrocket, appSlug: e.target.value },
                  }))
                }
                className={inputCls + " font-mono"}
              />
            </Field>
          </>
        )}
      </Section>

      {/* Submit area spans both columns */}
      <div className="md:col-span-2 flex flex-col gap-4">
        {formError ? (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {formError}
          </div>
        ) : null}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
          <button
            type="submit"
            disabled={submitDisabled}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-brand-500 px-5 py-3 text-sm font-medium text-ink-950 hover:bg-brand-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {running ? (
              <>
                <Spinner />
                <span>Triaging… {elapsedSeconds}s</span>
              </>
            ) : (
              <span>Run triage</span>
            )}
          </button>
          <p className="text-xs text-ink-500">
            <span aria-hidden>🔒</span>{" "}
            Credentials only live in your browser — they&apos;re sent
            transiently to the server for one request and never stored.
          </p>
        </div>
      </div>
    </form>
  );
}

// ----- Subcomponents ------------------------------------------------------

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <fieldset className="rounded-lg border border-ink-800 bg-ink-900/40 p-5 flex flex-col gap-3">
      <legend className="px-2 text-xs font-mono uppercase tracking-wider text-ink-500">
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-ink-300">
        {label}
        {hint ? (
          <span className="ml-2 text-ink-500 font-normal">{hint}</span>
        ) : null}
      </span>
      {children}
    </label>
  );
}

function Spinner(): JSX.Element {
  return (
    <svg
      className="h-4 w-4 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="3"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ----- Shared input classes -----------------------------------------------

const inputCls =
  "w-full rounded-md border border-ink-700 bg-ink-950/60 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-600 focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500/60";

const selectCls =
  "w-full rounded-md border border-ink-700 bg-ink-950/60 px-3 py-2 text-sm text-ink-100 focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500/60";
