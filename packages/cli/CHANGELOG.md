# Changelog

All notable changes to the `crashscope` CLI are documented in this file. The
format follows [Conventional Commits](https://www.conventionalcommits.org/) and
the project adheres to [Semantic Versioning](https://semver.org/).

## 0.1.1

### Fixed

- Upgrade to zod 4 to align with @anthropic-ai/claude-agent-sdk's peer-dep
  requirement; eliminates the conflicting-peer-dependency warning on
  `npm install -g`.

## Unreleased

### Added

- `feat(cli)`: live credential validation in the `init` wizard — each
  provider's token is verified against the smallest authenticated endpoint
  before the config is persisted (Sentry, Rollbar, Bugsnag, Honeybadger,
  PostHog, and Anthropic).
- `feat(cli)`: empty-state hint on stderr when `crashscope triage` finds zero
  errors in the requested window.
- `feat(cli)`: Markdown output mode (`output/markdown.ts`) suitable for
  pasting into GitHub / Linear issues.
- `feat(cli)`: `--out <path>` flag to write the report to disk. The output
  format is inferred from the file extension (`.md`, `.json`, `.txt`) unless
  `--format md|json|terminal` is also passed.
- `feat(cli)`: `--dry-run` flag that skips the Claude investigation step and
  prints the matched errors and sessions, for verifying configuration without
  spending tokens.

### Changed

- `fix(cli)`: SIGINT now aborts the in-flight investigation cleanly through
  an `AbortController` plumbed into `investigate()` and the session-fetch
  loop. Exits with the conventional status code 130 on cancellation.
- `fix(cli)`: the Anthropic API key prompt in `init` now uses
  `password({ mask: "*" })` so the value is echo-masked.
- `fix(cli/config)`: `config.json` is now written atomically — we stage to a
  `.tmp` file, `chmod 0600`, and `rename` over the destination so a SIGINT
  mid-write can never leave the file truncated.
- `fix(cli/util)`: redaction patterns expanded to cover Sentry (`sntry_` /
  `sntrys_`), PostHog (`phx_` / `phc_`), Honeybadger (`hbp_`), Slack
  (`xoxb-` / `xoxp-`), generic `sk-ant-…` and `sk-…`, and bare Bearer
  values. The "Unknown error" branch in `index.ts` also runs through redact
  before reaching stderr.
- `fix(cli/output)`: Slack delivery now chunks payloads to respect the
  50-block cap (~16 issues per payload). Each chunk is sent sequentially and
  failures are surfaced inline without aborting the remaining chunks. Action
  buttons whose `sourceUrl` / `replayUrl` isn't a valid http(s) URL are
  omitted instead of letting Slack reject the whole payload.
- `fix(cli)`: `bin/crashscope` catches dynamic-import rejections and prints
  a friendly load-failure hint instead of letting the rejection surface as
  an `UnhandledPromiseRejection`.
- `chore(cli)`: `engines.node` bumped to `>=20` to match the use of
  `AbortSignal.timeout` in the new credential probes. The `files` field now
  includes `CHANGELOG.md` and `LICENSE` so the published tarball ships with
  attribution and release notes.
