# crashscope

> AI-powered error triage that pairs your error tracker with session replay and Claude.

crashscope pulls fresh issues from your error tracker, joins each one against the user session that produced it, and asks Claude to investigate. The output is a ranked triage report — hypothesis, root-cause guess, files to inspect, user journey, confidence — delivered to your terminal, Slack, or a REST endpoint. Install the CLI for on-demand local runs, or deploy the server to expose `/api/triage` and a `/triage` Slack command across your team.

**Quick links:**
[CLI install](packages/cli/README.md) · [Vercel deploy](packages/server/README.md) · [Architecture](#architecture) · [Adapters](#adapter-matrix)

## Why

- **One digest, not five tabs.** Stop bouncing between Sentry, PostHog, GitHub, and your bug tracker to triage a single issue.
- **Morning triage on autopilot.** Schedule a daily Slack `/triage`, or run the CLI before standup — you walk in with a ranked list, not an unread queue.
- **Sessions tell stories errors can't.** Stack traces show what broke; replays show what the user did. crashscope hands Claude both, so the report ranks "what likely caused this" instead of "what threw".
- **Local-first when you want it, hosted when you don't.** Same triage pipeline runs in the CLI on your laptop or as a Next.js app on Vercel — pick the surface, not the engine.

## Architecture

```
                                                ┌───────────────────────────────┐
                                                │  outputs                      │
┌──────────────────┐                            │                               │
│ error trackers   │                            │  ┌─────────┐ ┌──────────────┐ │
│ Sentry, Rollbar, │                            │  │ terminal│ │ Slack webhook│ │
│ Bugsnag,         │                            │  └─────────┘ └──────────────┘ │
│ Honeybadger      │ ───┐                       │  ┌─────────┐ ┌──────────────┐ │
└──────────────────┘    │   ┌─────────────────┐ │  │ JSON    │ │ REST /api    │ │
                        ├──>│ @crashscope/core│─┼──┤         │ │ /triage      │ │
┌──────────────────┐    │   │                 │ │  └─────────┘ └──────────────┘ │
│ session tools    │ ───┘   │  adapters       │ │                               │
│ PostHog,         │        │   │             │ └───────────────────────────────┘
│ LogRocket        │        │   v             │
└──────────────────┘        │  agent ──> Claude
                            └─────────────────┘

deployment modes
────────────────
local CLI       :  `crashscope triage`  ──>  prints to terminal / posts to Slack
Vercel server   :  GET /api/triage      ──>  TriageReport JSON
                   POST /api/slack/*    ──>  /triage slash command
```

Both surfaces share `@crashscope/core` — same adapters, same investigation loop, same report shape. The split is purely about where the process runs.

## Adapter matrix

| Category | Provider     | Status |
| -------- | ------------ | ------ |
| Errors   | Sentry       | ✓      |
| Errors   | Rollbar      | ✓      |
| Errors   | Bugsnag      | ✓      |
| Errors   | Honeybadger  | ✓      |
| Sessions | PostHog      | ✓      |
| Sessions | LogRocket    | ✓      |
| Outputs  | Terminal     | ✓      |
| Outputs  | Slack        | ✓      |
| Outputs  | REST API     | ✓      |
| Outputs  | JSON         | ✓      |

All adapters live in `packages/core/src/adapters/{errors,sessions}` and implement the `ErrorAdapter` / `SessionAdapter` interfaces from `@crashscope/core`.

## Quick start — CLI

```sh
npm i -g crashscope
crashscope init                   # interactive wizard; writes ~/.crashscope/config.json (chmod 600)
crashscope triage                 # last 24h, up to 25 issues
crashscope triage --since 7d --limit 50 --severity fatal,error
crashscope triage --json | jq .
```

The wizard validates each credential against the live API as it goes, so you find out the token is wrong *before* you save it. Full command and flag reference: [packages/cli/README.md](packages/cli/README.md).

## Quick start — Server

```sh
git clone <your-fork>
cd crashscope
pnpm install
cp packages/server/.env.example packages/server/.env.local
# edit packages/server/.env.local with your provider credentials
pnpm --filter @crashscope/server dev
```

Dev server runs at `http://localhost:3000`. To deploy on Vercel, click the button in [packages/server/README.md](packages/server/README.md) or push a connected repo and copy the env vars into your project settings. The Next.js routes use the Node runtime (`maxDuration = 300`) so a long-running investigation finishes within Vercel's serverless limits.

## Authentication

crashscope has two distinct auth paths for Claude. The **CLI** prefers your local Claude Code subscription — if the `claude` binary is on `PATH` and a `~/.claude` directory exists, that path is used and no API key is needed. If that's missing, the CLI falls back to `ANTHROPIC_API_KEY` (env var or `anthropic.apiKey` in the config file). The **server** is API-key only: serverless functions don't have access to the local Claude Code auth context, so `ANTHROPIC_API_KEY` is required.

## Monorepo layout

```
crashscope/
├── packages/
│   ├── core/      # @crashscope/core — types, Zod schemas, agent loop, 4 error + 2 session adapters
│   ├── cli/       # crashscope — npm-installable CLI; commands: init, triage, config
│   └── server/    # @crashscope/server — Next.js app: landing page, REST /api/triage, Slack bot
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── package.json   # workspace root
```

## Development

**Prereqs:** Node `>=18.18`, pnpm `9.x`.

```sh
pnpm install              # at the repo root
pnpm -r typecheck         # strict TS check across every workspace
pnpm -r build             # compile every package (tsc -b for core/cli, next build for server)
```

Per-package dev commands:

| Package              | Dev command                              | Notes                                |
| -------------------- | ---------------------------------------- | ------------------------------------ |
| `@crashscope/core`   | `pnpm --filter @crashscope/core build`   | Pure TS — no watch mode needed.      |
| `crashscope`         | `pnpm --filter crashscope build`         | Then run `node packages/cli/bin/crashscope …`. |
| `@crashscope/server` | `pnpm --filter @crashscope/server dev`   | Next.js dev server on port 3000.     |

## Configuration

The CLI stores config at `~/.crashscope/config.json` (or `$XDG_CONFIG_HOME/crashscope/config.json` when set). The file is chmod-600. Shape:

```yaml
errorProvider:   sentry | rollbar | bugsnag | honeybadger
sessionProvider: posthog | logrocket
outputs:         [terminal, slack, json]            # one or more
credentials:
  sentry:       { token, org, project }
  rollbar:      { readToken, project? }
  bugsnag:      { token, organizationId, projectId }
  honeybadger:  { token, projectId }
  posthog:      { apiKey, projectId, host? }
  logrocket:    { apiKey, appSlug }
  slack:        { webhookUrl?, botToken?, signingSecret? }   # one of webhookUrl/botToken required if 'slack' in outputs
anthropic:
  apiKey:       string?                              # optional; falls back to Claude Code
```

`crashscope init` walks every required field interactively. See [packages/cli/README.md](packages/cli/README.md#configuration) for the wizard, masking behaviour, and a worked example.

The server reads the same shape from environment variables instead of a file — see [packages/server/.env.example](packages/server/.env.example) and the [server README](packages/server/README.md#environment-variables) for the full table.

## API reference

```http
GET /api/triage?since=24h&limit=25&severity=fatal,error
Authorization: Bearer <CRASHSCOPE_API_TOKEN>
```

Returns a `TriageReport` JSON object (typed in `@crashscope/core`). `since` accepts `1h | 6h | 24h | 7d | 14d | 30d`. `limit` defaults to 25, max 100. `severity` is a comma-separated subset of `fatal,error,warning,info`. Errors return `{ error, message, requestId }`; an `X-Request-Id` header is set on every response for log correlation. Full status-code table in [packages/server/README.md](packages/server/README.md#rest-api).

## Project status

`0.1.0` — initial release. Adapter coverage complete, core triage flow working, integration tests pending.

## License

MIT.
