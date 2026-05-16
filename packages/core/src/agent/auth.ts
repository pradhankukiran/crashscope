import { exec } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AuthError } from "../errors.js";
import type { CrashscopeConfig } from "../types/config.js";

const execAsync = promisify(exec);

/**
 * How the agent will authenticate to Anthropic for the duration of the run.
 *
 * - `api-key`: a direct Anthropic API key (from config or `ANTHROPIC_API_KEY`).
 *   The investigation loop will set `ANTHROPIC_API_KEY` in the SDK's env so the
 *   Claude Code transport uses the key instead of the local subscription.
 * - `claude-code`: rely on the user's local Claude Code installation/login.
 *   The SDK auto-discovers credentials via `~/.claude`.
 */
export type AuthResolution =
  | { mode: "api-key"; apiKey: string }
  | { mode: "claude-code" };

/**
 * Filenames Claude Code has historically used to store the active credential
 * blob inside `~/.claude`. We probe both forms because the SDK and CLI have
 * shipped under each at different points; opening either non-empty file is
 * sufficient evidence that the user has logged in.
 */
const CREDENTIAL_FILES = [".credentials.json", "credentials.json"] as const;

/** Max time we allow `claude --version` to take before giving up. */
const VERSION_PROBE_TIMEOUT_MS = 2_000;

/**
 * Check whether the `claude` binary is on PATH **and** actually executes.
 *
 * Two stages:
 * 1. `command -v` / `where` — confirms the binary is reachable.
 * 2. `claude --version` with a hard 2-second timeout — confirms it runs
 *    without hanging on, e.g., a broken Node install. Sandboxed runners
 *    sometimes have the binary on PATH but block child_process; the version
 *    probe surfaces that case as "missing" rather than a vague auth failure
 *    later in the SDK call.
 *
 * Returns `true` only when both stages succeed.
 */
async function isClaudeBinaryUsable(): Promise<boolean> {
  const isWindows = process.platform === "win32";
  const probe = isWindows ? "where claude" : "command -v claude";
  try {
    const { stdout } = await execAsync(probe, { windowsHide: true });
    if (stdout.trim().length === 0) return false;
  } catch {
    return false;
  }
  try {
    const { stdout, stderr } = await execAsync("claude --version", {
      windowsHide: true,
      timeout: VERSION_PROBE_TIMEOUT_MS,
    });
    // Some versions print to stderr; accept either as long as something came back.
    return stdout.trim().length > 0 || stderr.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Verify the user has actually logged in to Claude Code by locating a
 * non-empty credentials blob inside `~/.claude`.
 *
 * We don't parse or validate the contents — the SDK owns the schema and it
 * changes between releases. A non-empty file is good enough evidence.
 */
async function hasClaudeCredentials(): Promise<boolean> {
  const home = homedir();
  for (const filename of CREDENTIAL_FILES) {
    try {
      const info = await stat(join(home, ".claude", filename));
      if (info.isFile() && info.size > 0) return true;
    } catch {
      // try the next candidate
    }
  }
  return false;
}

/**
 * Resolve which Anthropic auth path crashscope should use for this run.
 *
 * Precedence:
 * 1. `config.apiKey` (explicit in CrashscopeConfig).
 * 2. `ANTHROPIC_API_KEY` env var.
 * 3. Local Claude Code installation. This requires **both**:
 *    - a usable `claude` binary on PATH (existence + `claude --version`
 *      returns within {@link VERSION_PROBE_TIMEOUT_MS}), AND
 *    - a non-empty `~/.claude/(.)credentials.json` proving the user has
 *      logged in at least once.
 *    Either alone is insufficient — a fresh install has no creds; a stale
 *    config dir without the binary can't authenticate the SDK.
 *
 * Throws {@link AuthError} with provider "anthropic" if none of the above are
 * available, so the CLI can render a targeted hint.
 *
 * Note: API key handling is per-call by design. The investigation loop passes
 * the key via `env: { ...process.env, ANTHROPIC_API_KEY }` to the SDK
 * options. We deliberately never mutate `process.env` here so concurrent
 * runs with different keys (e.g. in a server context) don't interfere.
 */
export async function resolveAnthropicAuth(
  config?: CrashscopeConfig["anthropic"],
): Promise<AuthResolution> {
  const explicitKey = config?.apiKey?.trim();
  if (explicitKey && explicitKey.length > 0) {
    return { mode: "api-key", apiKey: explicitKey };
  }

  const envKey = process.env["ANTHROPIC_API_KEY"]?.trim();
  if (envKey && envKey.length > 0) {
    return { mode: "api-key", apiKey: envKey };
  }

  const [binaryUsable, credsPresent] = await Promise.all([
    isClaudeBinaryUsable(),
    hasClaudeCredentials(),
  ]);
  if (binaryUsable && credsPresent) {
    return { mode: "claude-code" };
  }

  // Compose a targeted hint based on which check failed so the user knows
  // whether to log in or install/repair the binary.
  const reasons: string[] = [];
  if (!binaryUsable) {
    reasons.push("the `claude` CLI is not on PATH or did not respond to `claude --version` within 2s");
  }
  if (!credsPresent) {
    reasons.push(
      "no non-empty credential file was found under ~/.claude (looked for " +
        CREDENTIAL_FILES.map((f) => `~/.claude/${f}`).join(", ") +
        ")",
    );
  }
  throw new AuthError(
    "anthropic",
    "No Anthropic credentials found. Set ANTHROPIC_API_KEY in your environment, " +
      "provide `anthropic.apiKey` in your crashscope config, or install and log " +
      "into Claude Code (https://claude.com/code). " +
      (reasons.length > 0 ? `Diagnostics: ${reasons.join("; ")}.` : ""),
  );
}
