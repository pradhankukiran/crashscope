# @crashscope/core

Shared types, Zod schemas, adapter interfaces, and error classes for [crashscope](../../README.md). Every other package in the monorepo — adapters, CLI, runner — depends on this one. It depends only on `zod`.

## What's in here

- **Normalized types** (`NormalizedError`, `NormalizedSession`, `NormalizedEvent`) — provider-agnostic shapes that adapters translate into.
- **Adapter interfaces** (`ErrorAdapter`, `SessionAdapter`) — the contracts every integration implements.
- **Configuration** (`CrashscopeConfig`) — Zod-validated user config including per-provider credentials and output channels.
- **Triage report** (`TriageReport`, `TriageIssue`) — the artifact crashscope emits.
- **Errors** (`AdapterError`, `ConfigError`, `AuthError`, `ValidationError`) — typed failure modes with stable `code` fields.

## Importing

```ts
// Everything (most consumers).
import {
  type NormalizedError,
  type ErrorAdapter,
  normalizedErrorSchema,
  AdapterError,
} from "@crashscope/core";

// Or via the subpath exports if you prefer.
import type { SessionAdapter } from "@crashscope/core/types";
import { ConfigError } from "@crashscope/core/errors";
```

## Example: implementing an adapter

```ts
import {
  type ErrorAdapter,
  type FetchRecentOptions,
  type NormalizedError,
  AdapterError,
} from "@crashscope/core";

export class SentryAdapter implements ErrorAdapter {
  public readonly name = "sentry";

  public async fetchRecent(opts: FetchRecentOptions): Promise<NormalizedError[]> {
    // 1. Call Sentry API with opts.since / opts.limit / opts.severities
    // 2. Map each issue payload into NormalizedError
    // 3. Throw AdapterError (or AuthError) on failure
    throw new AdapterError(this.name, "not implemented yet");
  }

  public async fetchDetail(id: string): Promise<NormalizedError> {
    throw new AdapterError(this.name, `not implemented yet (id=${id})`);
  }
}
```

Every payload returned from an adapter should round-trip through the matching schema (`normalizedErrorSchema.parse(...)`) in development so contract drift is caught before it reaches the LLM.

## Versioning

Types and schemas are part of the public surface of this package. Breaking changes to `NormalizedError`, `NormalizedSession`, or the adapter interfaces require a major bump.
