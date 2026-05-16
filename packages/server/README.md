# @crashscope/server

Next.js app for crashscope: marketing landing page, REST triage API, and Slack bot in a single deployable surface.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fpradhankukiran%2Fcrashscope%2Ftree%2Fmaster%2Fpackages%2Fserver)

## What you get

- `/` — marketing landing page, including a public **"Try it now"** form that lets any visitor run a triage live with their own credentials.
- `GET /api/health` — uptime probe.
- `GET /api/triage` — programmatic triage (bearer-authed, uses server env).
- `POST /api/triage` — public demo triage. No bearer; credentials and the Anthropic API key come from the request body. Powers the landing-page form.
- `POST /api/slack/command` — `/triage` Slack slash command.
- `POST /api/slack/events` — Slack URL verification + future event handlers.

The triage pipeline runs inside `lib/triage.ts` and is shared by both the REST endpoint and the Slack bot, so behavior is identical across surfaces. The public POST mode supplies its own `CrashscopeConfig` via the new `configOverride` parameter on `runTriage`.

## Deploy to Railway (recommended)

Railway is the recommended deploy target for crashscope. The server runs as a long-lived Node process inside Docker, which fits the workload better than a serverless surface:

- **Long Claude calls finish.** A triage may take 30–120s. On Vercel that hits the function-duration ceiling and you pay for `waitUntil` plumbing to keep the background work alive. On Railway the request stays inside the same Node process for its whole life — no timeouts to negotiate, no callback dance.
- **Slack bot lifecycle is simpler.** The `/triage` slash command fires off a background job and posts back to Slack's `response_url`. With a real long-running process that's just an awaited promise; on serverless it requires `@vercel/functions`' `waitUntil` to survive the response (still works, just more moving parts).
- **One image, many hosts.** The Dockerfile at `packages/server/Dockerfile` is portable — Railway today, any container host tomorrow (Fly.io, Render, Cloud Run, a VPS).

### One-command deploy

```sh
# from the monorepo root
railway init        # link/create a Railway project
railway up          # build the Dockerfile and ship the image
railway domain      # mint a public URL for the service
```

`railway.json` at the repo root tells Railway to use `packages/server/Dockerfile` and to health-check `/api/health` after each deploy. The Dockerfile reads `PORT` from Railway's injected env var; Next's standalone server respects it directly.

### Set environment variables

Either through the dashboard (Settings → Variables) or from the CLI:

```sh
railway variables set ANTHROPIC_API_KEY=sk-ant-...
railway variables set CRASHSCOPE_API_TOKEN=$(openssl rand -hex 32)
railway variables set ERROR_PROVIDER=sentry
railway variables set SENTRY_TOKEN=...
railway variables set SENTRY_ORG=...
railway variables set SENTRY_PROJECT=...
railway variables set SESSION_PROVIDER=posthog
railway variables set POSTHOG_API_KEY=...
railway variables set POSTHOG_PROJECT_ID=...
railway variables set SLACK_SIGNING_SECRET=...
railway variables set SLACK_BOT_TOKEN=xoxb-...
```

See the [Environment variables](#environment-variables) table below for the full list. Required-vs-conditional gates are enforced by `lib/config.ts`; if you forget one, the boot-time `instrumentation.ts` hook will surface a single `ConfigError` listing every absent var.

### Deploy to Vercel (still supported)

The same code still builds on Vercel — push the repo, point a project at `packages/server`, and paste env vars into the project settings. The `[Deploy with Vercel]` badge above is the one-click path. Long-running Claude calls work via `waitUntil` from `@vercel/functions`, which is a safe no-op on Railway and a function-keep-alive on Vercel; the codebase has a single source path for both.

### Any other container host

The Dockerfile is platform-agnostic. To build and run locally:

```sh
docker build -f packages/server/Dockerfile -t crashscope-server .
docker run --rm -p 3000:3000 --env-file packages/server/.env.local crashscope-server
```

The build context must be the monorepo root (because pnpm workspaces).

## Local development

```bash
pnpm install          # from the repo root
pnpm -r build         # build @pradhankukiran/crashscope-core so the server can import it
cp packages/server/.env.example packages/server/.env.local
# edit .env.local with your provider credentials
pnpm --filter @crashscope/server dev
```

The dev server listens on http://localhost:3000.

## Environment variables

| Variable                 | Required | Notes                                                                 |
| ------------------------ | -------- | --------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`      | yes      | Claude auth. Server mode is API-key only.                             |
| `CRASHSCOPE_API_TOKEN`   | yes      | Bearer token clients send to `/api/triage`.                           |
| `ERROR_PROVIDER`         | yes      | `sentry`, `rollbar`, `bugsnag`, or `honeybadger`.                     |
| `SENTRY_TOKEN`           | conditional | required when `ERROR_PROVIDER=sentry`                              |
| `SENTRY_ORG`             | conditional | required when `ERROR_PROVIDER=sentry`                              |
| `SENTRY_PROJECT`         | conditional | required when `ERROR_PROVIDER=sentry`                              |
| `ROLLBAR_TOKEN`          | conditional | required when `ERROR_PROVIDER=rollbar`                             |
| `ROLLBAR_PROJECT`        | optional | passed through to the Rollbar adapter when set                        |
| `BUGSNAG_TOKEN`          | conditional | required when `ERROR_PROVIDER=bugsnag`                             |
| `BUGSNAG_ORGANIZATION_ID`| conditional | required when `ERROR_PROVIDER=bugsnag`                             |
| `BUGSNAG_PROJECT_ID`     | conditional | required when `ERROR_PROVIDER=bugsnag`                             |
| `HONEYBADGER_TOKEN`      | conditional | required when `ERROR_PROVIDER=honeybadger`                         |
| `HONEYBADGER_PROJECT`    | conditional | required when `ERROR_PROVIDER=honeybadger`                         |
| `SESSION_PROVIDER`       | yes      | `posthog` or `logrocket`.                                             |
| `POSTHOG_API_KEY`        | conditional | required when `SESSION_PROVIDER=posthog`                           |
| `POSTHOG_PROJECT_ID`     | conditional | required when `SESSION_PROVIDER=posthog`                           |
| `POSTHOG_HOST`           | optional | override PostHog API host (EU cloud / self-hosted)                    |
| `LOGROCKET_API_KEY`      | conditional | required when `SESSION_PROVIDER=logrocket`                         |
| `LOGROCKET_APP_SLUG`     | conditional | required when `SESSION_PROVIDER=logrocket`                         |
| `SLACK_SIGNING_SECRET`   | yes      | Used to verify Slack request signatures.                              |
| `SLACK_BOT_TOKEN`        | yes      | Bot token (`xoxb-…`) for richer responses if used later.              |

Required-vs-conditional gates are enforced by `lib/config.ts`; a missing variable surfaces as a single `ConfigError` listing every absent var.

## REST API

### `GET /api/triage` — env-driven mode

```http
GET /api/triage?since=24h&limit=25&severity=fatal,error
Authorization: Bearer <CRASHSCOPE_API_TOKEN>
```

Parameters:

- `since` (default `24h`): one of `1h`, `6h`, `24h`, `7d`, `14d`, `30d`.
- `limit` (default `25`, max `100`).
- `severity` (optional): comma-separated subset of `fatal,error,warning,info`.

Responses:

- `200 OK` — full `TriageReport` JSON (see `@pradhankukiran/crashscope-core` types).
- `400 Bad Request` — bad query parameter.
- `401 Unauthorized` — missing or invalid bearer token.
- `5xx` — adapter, auth, or pipeline failure. Body: `{ error, message, requestId }`.

All responses set `Cache-Control: no-store` and an `X-Request-Id` header for log correlation.

### `POST /api/triage` — public demo mode

Used by the landing-page form. Intentionally unauthenticated: visitors paste their own credentials, the server uses them transiently for a single request, and nothing is persisted.

```http
POST /api/triage
Content-Type: application/json
```

Body (validated with Zod, mirroring `crashscopeConfigSchema` from `@pradhankukiran/crashscope-core`):

```jsonc
{
  "errorProvider": "sentry",
  "sessionProvider": "posthog",
  "credentials": {
    "sentry":  { "token": "...", "org": "...", "project": "..." },
    "posthog": { "apiKey": "...", "projectId": "...", "host": "https://us.i.posthog.com" }
  },
  "anthropic": { "apiKey": "sk-ant-..." },  // REQUIRED here
  "opts": { "since": "24h", "limit": 5 }
}
```

The `anthropic.apiKey` field is mandatory on this endpoint — the server never falls back to its own `ANTHROPIC_API_KEY` env var for the public demo.

> **Limit asymmetry:** `POST /api/triage` caps `opts.limit` at **25** (the public demo path is deliberately tighter than the bearer-authed GET, which caps at 100). Requests above the cap return `400 Bad Request`.

## Slack setup

1. Create a new Slack app at [api.slack.com/apps](https://api.slack.com/apps).
2. Under **Slash Commands**, add `/triage` pointing to `https://your-host/api/slack/command`.
3. Under **OAuth & Permissions** → **Scopes** → **Bot Token Scopes**, add:
   - `commands` — required so Slack can invoke `/triage`.
   - `chat:write` — reserved for future use (no `chat.postMessage` is called
     yet; add it now so you don't have to reinstall later).

   No **Redirect URL** is needed — crashscope does not run an OAuth callback;
   the bot is installed directly to the workspace from the app config page.
4. Under **Event Subscriptions**, set the request URL to `https://your-host/api/slack/events`. Slack will hit `url_verification`; this endpoint answers it automatically.
5. Copy the **Signing Secret** into `SLACK_SIGNING_SECRET` and the **Bot User OAuth Token** into `SLACK_BOT_TOKEN`. Note: `SLACK_BOT_TOKEN` is currently reserved for future use — no `chat.postMessage` calls are made yet, but populate it now so richer responses light up the moment they ship.
6. Install the app to your workspace.

In Slack, run `/triage`, `/triage 7d`, or `/triage 24h severity=fatal,error`.

## Architecture notes

- `lib/env.ts` — Zod-validated `process.env` loader. Memoized.
- `lib/config.ts` — builds a `CrashscopeConfig` from validated env. Aggregates missing vars into one `ConfigError`.
- `lib/triage.ts` — instantiates adapters, runs `investigate()`, returns a `TriageReport`.
- `lib/slack/verify.ts` — HMAC-SHA256 signature check with replay protection.
- `lib/slack/blocks.ts` — Block Kit builders for reports and errors.
- `lib/slack/parse.ts` — slash-command text parser.
- `app/api/...` — Next.js Route Handlers (Node runtime; `maxDuration = 300`).

## Scripts

| Command           | Purpose                            |
| ----------------- | ---------------------------------- |
| `pnpm dev`        | Next.js dev server on port 3000.   |
| `pnpm build`      | Production build.                  |
| `pnpm start`      | Serve the production build.        |
| `pnpm typecheck`  | Strict TS check (no emit).         |
| `pnpm lint`       | Next.js ESLint runner.             |
