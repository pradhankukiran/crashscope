# crashscope · test harness

A single-page test app that sends matched Sentry errors and PostHog session
events under a shared user ID — so the crashscope CLI has real data to triage.

The same Sentry + PostHog data is consumed by `crashscope triage` (CLI) and
by the server's `/api/triage` endpoint — both surfaces share the adapter and
investigation pipeline in `@pradhankukiran/crashscope-core`, so the test harness exercises
the whole stack with one set of synthetic events.

No build step. CDN-loaded SDKs. Open it in a browser.

The same harness is also served by the deployed Next.js app at
<https://crashscope-web-production.up.railway.app/test-harness/> — use that
if you'd rather skip the local-server step.

## What you need

From your Sentry project (the one you want crashscope to monitor):

- **Sentry DSN** — Sentry → Project Settings → **Client Keys (DSN)** → copy the
  full `https://…@oXXX.ingest.sentry.io/YYYYY` value.

From your PostHog project:

- **PostHog Project API Key** (starts with `phc_…`) — PostHog → Project Settings
  → **Project API Key**. This is the public key for ingestion, _not_ your
  personal `phx_…` key.
- **PostHog Host** — `https://us.i.posthog.com`, `https://eu.i.posthog.com`,
  or your self-hosted URL.

A **User ID** of your choice (e.g. `test-user-1`) — same value will be sent to
both Sentry (`Sentry.setUser`) and PostHog (`posthog.identify`).

## Usage

1. Open the harness in your browser. Two paths:
   - **Hosted (no setup):** <https://crashscope-web-production.up.railway.app/test-harness/>
   - **Self-hosted:**
     ```bash
     cd examples/test-app
     python3 -m http.server 8080
     # then visit http://localhost:8080
     ```
     (Opening directly via `file://` works in most browsers but a local server
     is more reliable.)
2. Paste your DSN, PostHog key, host, and user ID.
3. Click **Save & Initialize**. The status line will turn green and the SDKs
   start sending events.
4. Use the buttons in sections 2–4 to generate errors and session activity.
5. Wait ~30 seconds for Sentry + PostHog to propagate the data.
6. Run crashscope. If you installed it globally:
   ```bash
   crashscope triage --since=1h
   ```
   Or, if you're running from a source checkout:
   ```bash
   # from the repo root, after `pnpm install && pnpm -r build`
   node packages/cli/bin/crashscope triage --since=1h
   ```

## What each section does

- **Section 2 · Trigger Errors** — fires different error types (TypeError,
  ReferenceError, RangeError, async error, unhandled rejection, manual capture,
  network 404). All tagged with your user ID, so PostHog sessions will match.
- **Section 3 · Simulate User Interaction** — clicks, input changes, fake
  navigation, rage clicks, and a manual `posthog.capture()`. Builds the session
  recording that will be linked to the error.
- **Section 4 · Combined Flow** — one button that runs a realistic scenario:
  click → input → submit → navigate → rage click → custom error. This is the
  most useful test for the triage agent because Claude gets rich session
  context to reason about.

## Tips

- Open DevTools → Network to confirm events are reaching `sentry.io` and your
  PostHog host.
- Errors caught with `try/catch` and forwarded via `Sentry.captureException`
  appear in Sentry as proper issues. Errors that bubble up to the global
  handler also work (Sentry installs handlers automatically).
- Config is persisted to localStorage so you don't have to re-paste keys.
- Toggle **Clear saved config** if you want to switch projects.
