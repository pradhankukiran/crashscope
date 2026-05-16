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

## Local development

```bash
pnpm install          # from the repo root
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

- `200 OK` — full `TriageReport` JSON (see `@crashscope/core` types).
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

Body (validated with Zod, mirroring `crashscopeConfigSchema` from `@crashscope/core`):

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

## Slack setup

1. Create a new Slack app at [api.slack.com/apps](https://api.slack.com/apps).
2. Under **Slash Commands**, add `/triage` pointing to `https://your-host/api/slack/command`.
3. Under **Event Subscriptions**, set the request URL to `https://your-host/api/slack/events`. Slack will hit `url_verification`; this endpoint answers it automatically.
4. Copy the **Signing Secret** into `SLACK_SIGNING_SECRET` and the **Bot User OAuth Token** into `SLACK_BOT_TOKEN`.
5. Install the app to your workspace.

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
