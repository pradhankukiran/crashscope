# Contributing to crashscope

Thanks for your interest! crashscope is open-source friendly — adapters, output channels, and quality-of-life improvements are all welcome.

## Monorepo conventions

- **pnpm workspaces.** Every package lives under `packages/*`. Workspace deps are pinned with `workspace:*` (see `packages/cli/package.json`).
- **TypeScript strict.** The shared `tsconfig.base.json` enables `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, and friends. New code must compile cleanly under `pnpm -r typecheck` with no `// @ts-expect-error` escape hatches.
- **NodeNext module resolution.** All relative imports must include the `.js` suffix, even though the source file is `.ts`:

  ```ts
  // good
  import { foo } from "./foo.js";
  // bad — will not resolve at runtime
  import { foo } from "./foo";
  ```

- **No runtime deps in `@crashscope/core` beyond `zod` and `@anthropic-ai/claude-agent-sdk`.** Adapters and the CLI depend on `core`, never the other way around.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/) with a package scope. Match the existing log:

```
feat(core): adapter interfaces
feat(adapters): sentry error adapter with zod-validated responses
feat(cli): init command (interactive wizard)
feat(server): /api/health and /api/triage endpoints
docs(server): readme and .env.example
chore: monorepo scaffold (workspaces, tsconfig base, root package.json)
```

Scopes in use: `core`, `adapters`, `cli`, `server`, `docs`, `chore`. One logical change per commit — small, atomic commits are easier to review than one giant one.

## Adding a new adapter

Adapters live in `packages/core/src/adapters/errors/` or `packages/core/src/adapters/sessions/`. Pick the right folder, then:

1. **Implement the interface.** `ErrorAdapter` (with `fetchRecent` / `fetchDetail`) or `SessionAdapter` (with `fetchForError`). Both are defined in `packages/core/src/types/adapters.ts`.
2. **Zod-validate every API response.** Define a schema for the provider's payload, call `.parse()` on the raw response, then map the validated value into `NormalizedError` / `NormalizedSession`. Contract drift in the upstream API should fail loudly here, not silently propagate to the LLM.
3. **Retry on `429` and `5xx`.** Exponential backoff with jitter, with a finite retry budget. Look at `packages/core/src/adapters/errors/sentry.ts` for the established pattern.
4. **Throw `AdapterError` on persistent failure.** Use `AuthError` for `401`/`403`, `AdapterError` for everything else. Both are in `packages/core/src/errors.ts`. Include the upstream status code and a short, actionable message — this is what the user sees.
5. **Add the credentials shape to `packages/core/src/types/config.ts`** and the provider name to `errorProviderSchema` / `sessionProviderSchema` in the same folder.
6. **Wire it into the factory** in `packages/cli/src/adapters/factory.ts` (CLI) and `packages/server/src/lib/triage.ts` (server) so both surfaces can use it.
7. **Extend the wizard** in `packages/cli/src/commands/init.ts` so `crashscope init` prompts for the new credentials.
8. **Document it.** Update the adapter matrix in the root `README.md`, the env-var table in `packages/server/README.md`, and the YAML config shape there too.

Once the adapter is exported from `@crashscope/core/adapters/{errors,sessions}`, both the CLI and the server pick it up.

## Branch / PR workflow

- Fork the repo and branch from `master`. Branch names: `feat/<short-slug>`, `fix/<short-slug>`, `docs/<short-slug>`.
- Run `pnpm -r typecheck` before pushing.
- Open a PR against `master`. Describe the change, link any related issue, and include a short test plan. Screenshots help for CLI output or Slack message changes.
- Squash-merge is fine for small PRs; multi-commit merge for larger work with clean history.

## Code style

- **No `any`.** Use `unknown` for genuinely-unknown values and narrow with Zod or a type guard.
- **Type-only imports.** Use `import type` for types that aren't needed at runtime — required under `verbatimModuleSyntax`:

  ```ts
  import type { NormalizedError } from "@crashscope/core";
  import { AdapterError } from "@crashscope/core";
  ```

- **No `console.log` outside debug paths.** User-facing output goes through the CLI's formatters in `packages/cli/src/output/`; server logs go through the per-request logger in `packages/server/src/lib/`. Gate diagnostic logging behind an explicit `--debug` flag or `CRASHSCOPE_DEBUG=1` env var.
- **Prettier formatting** (`pnpm format`) and ESLint (`pnpm lint`) before committing.
- Comments explain *why*, not *what*. The code shows *what*.

## Questions

Open a GitHub issue with the `question` label, or start a discussion. PRs that touch the adapter interface or the report schema should be discussed in an issue first — those are part of the public surface and bumping them is a breaking change.
