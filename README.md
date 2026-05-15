# crashscope

AI-powered error triage. crashscope pulls fresh issues from your error tracker, joins them against the matching user session/replay, and asks Claude to produce a ranked report with hypotheses, root-cause guesses, and links back to the original tools — so an on-call engineer reads one digest instead of context-switching across five tabs.

## Adapter coverage

| Surface         | Providers                                  |
| --------------- | ------------------------------------------ |
| Error trackers  | Sentry, Rollbar, Bugsnag, Honeybadger      |
| Session/replay  | PostHog, LogRocket                         |
| Output channels | Terminal, Slack, JSON                      |

Adapters live in their own packages (`@crashscope/adapter-*`) and conform to the `ErrorAdapter` / `SessionAdapter` interfaces defined in `@crashscope/core`.

## Monorepo layout

```
crashscope/
├── packages/
│   └── core/          # @crashscope/core — types, Zod schemas, adapter interfaces, errors
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── package.json       # workspace root
```

Future packages (adapters, CLI, runner, integrations) slot in under `packages/`.

## Toolchain

- TypeScript 5.6, strict mode, NodeNext modules
- pnpm workspaces (9.x)
- Node >= 18.18
- Zod for runtime validation at every adapter boundary

## Development

```sh
pnpm install
pnpm build       # tsc -b across all packages
pnpm typecheck   # tsc -b --noEmit
```
