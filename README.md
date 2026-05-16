<h1 align="center">crashscope</h1>

<p align="center">
  <strong>An AI-powered error triage CLI that knows what the user did before the crash.</strong>
  <br/>
  Pairs your error tracker with session replay and uses Claude to produce ranked, actionable triage reports — for the terminal, Slack, or your own API consumer.
</p>

<p align="center">
  <a href="#license"><img alt="License" src="https://img.shields.io/badge/license-MIT-f97316?style=flat-square"/></a>
  <a href="#monorepo-layout"><img alt="Monorepo" src="https://img.shields.io/badge/monorepo-pnpm%20workspaces-F69220?style=flat-square&logo=pnpm&logoColor=white"/></a>
  <a href="#project-status"><img alt="Status" src="https://img.shields.io/badge/status-0.1.0%20alpha-ea580c?style=flat-square"/></a>
  <a href="https://nodejs.org"><img alt="Node" src="https://img.shields.io/badge/node-%3E%3D18.18-43853d?style=flat-square&logo=nodedotjs&logoColor=white"/></a>
  <a href="https://www.typescriptlang.org"><img alt="TypeScript" src="https://img.shields.io/badge/typescript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white"/></a>
</p>

<p align="center">
  <a href="#quick-start--cli"><img src="https://img.shields.io/badge/install_CLI-from_source-000?style=for-the-badge&logo=github&logoColor=white"/></a>
  &nbsp;
  <a href="#for-teams-deploy-the-server-optional"><img src="https://img.shields.io/badge/Deploy_to_Vercel-▲-black?style=for-the-badge&logo=vercel&logoColor=white"/></a>
</p>

<p align="center">
  <a href="packages/cli/README.md">CLI docs</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#adapter-matrix">Adapters</a> ·
  <a href="#api-reference">API</a> ·
  <a href="#tech-stack">Tech stack</a> ·
  <a href="packages/server/README.md">Server docs</a>
</p>

---

crashscope pulls fresh issues from your error tracker, joins each one against the user session that produced it, and asks Claude to investigate. The output is a ranked triage report — hypothesis, root-cause guess, files to inspect, user journey, confidence — delivered to your terminal, Slack, or a REST endpoint. Install the CLI to triage from your terminal. Deploying the server is optional — it's how teams expose a `/triage` Slack command or a REST API on top of the same pipeline.

Don't want to install just yet? Visit the [live demo](https://crashscope.vercel.app) (once it's deployed) to paste your credentials and preview the output.

## Why

- **One digest, not five tabs.** Stop bouncing between Sentry, PostHog, GitHub, and your bug tracker to triage a single issue.
- **Morning triage on autopilot.** Schedule a daily Slack `/triage`, or run the CLI before standup — you walk in with a ranked list, not an unread queue.
- **Sessions tell stories errors can't.** Stack traces show what broke; replays show what the user did. crashscope hands Claude both, so the report ranks "what likely caused this" instead of "what threw".
- **CLI by default, server when your team needs it.** The same triage pipeline runs locally from your terminal, or — if you need a Slack `/triage` command or a REST endpoint — as a Next.js app on Vercel. Same engine, optional second surface.

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

surfaces
────────
CLI (default)        :  `crashscope triage`  ──>  prints to terminal / posts to Slack
Server (optional)    :  GET /api/triage      ──>  TriageReport JSON
                        POST /api/triage     ──>  public demo with body credentials
                        POST /api/slack/*    ──>  /triage slash command
```

Both surfaces share `@crashscope/core` — same adapters, same investigation loop, same report shape. The CLI is the primary way in; the server is an optional surface for teams that need Slack or HTTP access on top of the same pipeline.

## Adapter matrix

<p>
  <img alt="Sentry"      src="https://img.shields.io/badge/Sentry-supported-362D59?style=flat-square&logo=sentry&logoColor=white"/>
  <img alt="Rollbar"     src="https://img.shields.io/badge/Rollbar-supported-3F65F1?style=flat-square&logo=rollbar&logoColor=white"/>
  <img alt="Bugsnag"     src="https://img.shields.io/badge/Bugsnag-supported-4949E4?style=flat-square&logo=bugsnag&logoColor=white"/>
  <img alt="Honeybadger" src="https://img.shields.io/badge/Honeybadger-supported-EE5E37?style=flat-square"/>
  <img alt="PostHog"     src="https://img.shields.io/badge/PostHog-supported-1D4AFF?style=flat-square&logo=posthog&logoColor=white"/>
  <img alt="LogRocket"   src="https://img.shields.io/badge/LogRocket-supported-764ABC?style=flat-square&logo=logrocket&logoColor=white"/>
</p>

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

All adapters live in `packages/core/src/adapters/{errors,sessions}` and implement the `ErrorAdapter` / `SessionAdapter` interfaces from `@crashscope/core`. Adding a new provider is roughly 100 lines plus a Zod schema — see [CONTRIBUTING.md](CONTRIBUTING.md#adding-a-new-adapter).

## Quick start — CLI

Coming soon to npm — for now, install from source:

```sh
git clone https://github.com/pradhankukiran/crashscope.git
cd crashscope
pnpm install
pnpm -r build
alias crashscope="node $PWD/packages/cli/bin/crashscope"
crashscope --version
```

Then:

```sh
crashscope init                   # interactive wizard; writes ~/.crashscope/config.json (chmod 600)
crashscope triage                 # last 24h, up to 25 issues
crashscope triage --since 7d --limit 50 --severity fatal,error
crashscope triage --json | jq .
```

The wizard validates required fields are present. Full command and flag reference: [packages/cli/README.md](packages/cli/README.md).

> We will publish to npm once every adapter has been verified against a live account.

## For teams: deploy the server (optional)

Deploy the Next.js server when your team wants `/triage` in Slack, a REST API to curl, or a public preview page where teammates can paste credentials and see crashscope work. The CLI alone is enough for personal use.

```sh
git clone https://github.com/pradhankukiran/crashscope.git
cd crashscope
pnpm install
cp packages/server/.env.example packages/server/.env.local
# edit packages/server/.env.local with your provider credentials
pnpm --filter @crashscope/server dev
```

Dev server runs at `http://localhost:3000`. The landing page includes a **public demo form** — visitors paste their own credentials, run a live triage, and see the report rendered on the page (nothing stored server-side). To deploy on Vercel, click the button in [packages/server/README.md](packages/server/README.md) or push a connected repo and paste env vars into your project settings.

## Authentication

crashscope has two distinct auth paths for Claude. The **CLI** prefers your local Claude Code subscription — if the `claude` binary is on `PATH` and a `~/.claude` directory exists, that path is used and no API key is needed. If that's missing, the CLI falls back to `ANTHROPIC_API_KEY` (env var or `anthropic.apiKey` in the config file). If you're going down the server path, note that serverless functions have no access to your local Claude Code auth context — so the **server** is API-key only: `ANTHROPIC_API_KEY` is required for the GET endpoint and Slack bot. The **public demo** at `POST /api/triage` requires the visitor to bring their own key in the request body.

## Monorepo layout

```
crashscope/
├── packages/
│   ├── core/      # @crashscope/core — types, Zod schemas, agent loop, 4 error + 2 session adapters
│   ├── cli/       # crashscope — npm-installable CLI; commands: init, triage, config
│   └── server/    # @crashscope/server — Next.js app: landing page, REST /api/triage, Slack bot
├── examples/
│   └── test-app/  # static HTML harness for generating matched Sentry + PostHog test data
├── assets/        # branding assets
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

This only applies when you deploy the server. The CLI doesn't expose any HTTP surface.

```http
GET /api/triage?since=24h&limit=25&severity=fatal,error
Authorization: Bearer <CRASHSCOPE_API_TOKEN>
```

```http
POST /api/triage
Content-Type: application/json

{ "errorProvider": "sentry", "sessionProvider": "posthog",
  "credentials": { "sentry": {...}, "posthog": {...} },
  "anthropic":   { "apiKey": "sk-ant-..." },
  "opts":        { "since": "24h", "limit": 25 } }
```

Both return a `TriageReport` JSON object (typed in `@crashscope/core`). `since` accepts `1h | 6h | 24h | 7d | 14d | 30d`. `limit` defaults to 25, max 100. `severity` is a comma-separated subset of `fatal,error,warning,info`. Errors return `{ error, message, requestId }`; an `X-Request-Id` header is set on every response for log correlation. Full status-code table in [packages/server/README.md](packages/server/README.md#rest-api).

## Tech stack

<p>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white"/>
  <img alt="Next.js"    src="https://img.shields.io/badge/Next.js_14-000000?style=for-the-badge&logo=nextdotjs&logoColor=white"/>
  <img alt="React"      src="https://img.shields.io/badge/React_18-20232A?style=for-the-badge&logo=react&logoColor=61DAFB"/>
  <img alt="Tailwind"   src="https://img.shields.io/badge/Tailwind_CSS-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white"/>
  <img alt="shadcn/ui"  src="https://img.shields.io/badge/shadcn%2Fui-000000?style=for-the-badge&logo=shadcnui&logoColor=white"/>
  <img alt="Zod"        src="https://img.shields.io/badge/Zod-3068b7?style=for-the-badge&logo=zod&logoColor=white"/>
  <img alt="Anthropic"  src="https://img.shields.io/badge/Anthropic_Claude-CC785C?style=for-the-badge&logo=anthropic&logoColor=white"/>
  <img alt="Vercel"     src="https://img.shields.io/badge/Vercel-000000?style=for-the-badge&logo=vercel&logoColor=white"/>
  <img alt="pnpm"       src="https://img.shields.io/badge/pnpm_9-F69220?style=for-the-badge&logo=pnpm&logoColor=white"/>
</p>

- **Language**: TypeScript with strict mode + `verbatimModuleSyntax` + `exactOptionalPropertyTypes`
- **Runtime**: Node 18.18+, ESM
- **Validation**: Zod schemas for every external boundary (provider APIs, request bodies, configs)
- **AI**: Anthropic Claude via `@anthropic-ai/claude-agent-sdk` with structured tool-use
- **Server**: Next.js 14 (App Router, Node runtime), shadcn/ui, Tailwind CSS, react-hook-form
- **CLI**: commander, @inquirer/prompts, chalk, boxen, ora
- **Build**: pnpm workspaces + TypeScript project references

## Project status

`0.1.0` — initial release. Adapter coverage complete, core triage flow working, integration tests pending.

## License

MIT.
