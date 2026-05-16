# crashscope

AI-powered error triage in your terminal. crashscope pulls recent errors from
your error tracker, joins each one with the session replay that produced it,
and asks Claude to produce a structured triage report — a hypothesis, a
root-cause guess, suggested files to inspect, the user journey leading to the
crash, and a confidence level.

Supported providers:

- **Error trackers:** Sentry, Rollbar, Bugsnag, Honeybadger
- **Session replays:** PostHog, LogRocket
- **Delivery:** terminal, Slack (incoming webhook), JSON
- **LLM auth:** Anthropic API key or local Claude Code subscription

## Install

```sh
npm i -g crashscope
```

Node 18.18 or newer is required.

## Quick start

```sh
crashscope init                  # interactive wizard, writes ~/.crashscope/config.json
crashscope triage                # default: last 24h, up to 25 issues
crashscope triage --since 7d --limit 50
crashscope triage --json | jq .
```

## Commands

| Command                  | What it does                                                    |
| ------------------------ | --------------------------------------------------------------- |
| `crashscope init`        | Interactive setup wizard. Validates credentials and writes a chmod-600 config. |
| `crashscope triage`      | Fetch errors, join with sessions, triage with Claude, deliver to configured outputs. |
| `crashscope config show` | Print the current config with credentials masked.               |
| `crashscope config path` | Print the path crashscope would read or write.                  |
| `crashscope config edit` | Open the config in `$EDITOR` (or `$VISUAL`).                    |

### `triage` flags

| Flag                  | Default            | Notes                                                              |
| --------------------- | ------------------ | ------------------------------------------------------------------ |
| `--since <duration>`  | `24h`              | Accepts `1h` / `6h` / `24h` / `7d` / `14d` / `30d`.                |
| `--limit <n>`         | `25`               | Positive integer — maximum errors to triage.                       |
| `--severity <list>`   | all                | Comma-separated: `fatal`, `error`, `warning`, `info`.              |
| `--output <list>`     | `config.outputs`   | Comma-separated: `terminal`, `slack`, `json`. Overrides the config. |
| `--json`              | off                | Alias for `--output json`.                                         |
| `--debug`             | off                | Verbose stack traces; writes raw API errors to `~/.crashscope/debug.log` (tokens redacted). |
| `--config <path>`     | `~/.crashscope/config.json` | Load configuration from an alternate location.            |

### Exit codes

| Code | Meaning                                                            |
| ---- | ------------------------------------------------------------------ |
| `0`  | Success.                                                           |
| `1`  | User error (bad arguments, missing config, validation failure).    |
| `2`  | Adapter or upstream API error (Sentry/Rollbar/PostHog/etc.).       |
| `3`  | Anthropic authentication failed.                                   |

## Configuration

Configuration lives at `~/.crashscope/config.json` (or
`$XDG_CONFIG_HOME/crashscope/config.json` when `XDG_CONFIG_HOME` is set). The
file is written with mode `0600` by both `crashscope init` and any subsequent
re-runs.

Run `crashscope config path` to print the resolved location, or `crashscope
config show` to inspect the file with credentials masked.

A minimal configuration looks like:

```json
{
  "errorProvider": "sentry",
  "sessionProvider": "posthog",
  "outputs": ["terminal"],
  "credentials": {
    "sentry": {
      "token": "sntrys_...",
      "org": "acme",
      "project": "web"
    },
    "posthog": {
      "apiKey": "phx_...",
      "projectId": "12345"
    }
  }
}
```

Add `outputs: ["terminal", "slack"]` and a `credentials.slack.webhookUrl` to
deliver every report to a Slack channel as well as your terminal.

## Anthropic auth

crashscope needs to talk to Claude. It resolves credentials in this order:

1. `anthropic.apiKey` in your crashscope config.
2. `ANTHROPIC_API_KEY` from your environment.
3. A local Claude Code installation — the `claude` binary on `PATH` **and** a
   `~/.claude` directory created by signing in at
   [claude.com/code](https://claude.com/code).

`crashscope init` runs the same detection at the end of the wizard, so you
can confirm "✓ Detected Claude Code subscription" or "✓ Anthropic API key
configured" before your first triage run.

## Slack delivery

Slack is supported via [incoming webhooks](https://api.slack.com/messaging/webhooks).
Create a webhook for the target channel and paste the URL into the wizard.
The CLI does not log webhook URLs to disk or stderr, and `crashscope config
show` masks the secret path component.

Bot tokens (`xoxb-...`) are accepted in the config schema for forward
compatibility but are not yet wired to `chat.postMessage`; use a webhook for
now.

## Troubleshooting

**`No crashscope config found`** — run `crashscope init`, or pass `--config`
to point at an existing file.

**`Config at … failed schema validation`** — `crashscope config edit` opens
the file; the error message lists every offending path. Re-run `crashscope
init` to regenerate from scratch.

**`Authentication error / anthropic`** — try setting `ANTHROPIC_API_KEY` in
your shell, or install Claude Code and sign in. `crashscope init` will tell
you which path it picked.

**Slack webhook rejected delivery (HTTP 404)** — the webhook URL is wrong or
has been revoked. Generate a new one in your Slack workspace and re-run
`crashscope init`.

**LogRocket / Bugsnag returns empty results** — both providers gate parts of
their API behind plan tiers. Run with `--debug` to capture the raw response
in `~/.crashscope/debug.log` (with secrets redacted).

## License

MIT — see [LICENSE](../../LICENSE) at the repo root.
