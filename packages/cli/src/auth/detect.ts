import {
  AuthError,
  resolveAnthropicAuth,
  type AuthResolution,
  type CrashscopeConfig,
} from "@pradhankukiran/crashscope-core";

/**
 * Outcome of the CLI's Anthropic-auth detection step.
 *
 * Two shapes:
 * - `ok: true` — auth is ready; carries the underlying {@link AuthResolution}
 *   plus a short human-readable label suitable for terminal output.
 * - `ok: false` — auth could not be resolved; carries the user-facing message
 *   and a list of remediation hints (no shell escapes, no markdown).
 */
export type AuthDetection =
  | {
      readonly ok: true;
      readonly resolution: AuthResolution;
      readonly label: string;
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly hints: readonly string[];
    };

/**
 * Try to resolve Anthropic auth without throwing.
 *
 * Wraps {@link resolveAnthropicAuth} so command code can branch on `ok` rather
 * than catching {@link AuthError}, and so we can attach UX hints in one place.
 *
 * `config` is the `anthropic` sub-block of {@link CrashscopeConfig}; it is
 * optional because `crashscope init` may run before any config has been
 * persisted.
 */
export async function detectAnthropicAuth(
  config?: CrashscopeConfig["anthropic"],
): Promise<AuthDetection> {
  try {
    const resolution = await resolveAnthropicAuth(config);
    return {
      ok: true,
      resolution,
      label:
        resolution.mode === "api-key"
          ? "Anthropic API key configured"
          : "Detected Claude Code subscription",
    };
  } catch (err: unknown) {
    if (err instanceof AuthError) {
      return {
        ok: false,
        message: err.message,
        hints: AUTH_FAIL_HINTS,
      };
    }
    // Unexpected throw — surface the underlying message but keep the hint
    // payload so the user always has a next step.
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message, hints: AUTH_FAIL_HINTS };
  }
}

/**
 * The remediation hints we show on any auth failure.
 *
 * Kept as a module-level constant so the wording is identical whether the
 * caller is `crashscope init` (interactive) or `crashscope triage`
 * (non-interactive) — the UX is brittle if these drift.
 */
const AUTH_FAIL_HINTS: readonly string[] = Object.freeze([
  "Set ANTHROPIC_API_KEY in your shell environment, or",
  "Add anthropic.apiKey to your crashscope config (~/.crashscope/config.json), or",
  "Install Claude Code (https://claude.com/code) and sign in so ~/.claude exists.",
]);
