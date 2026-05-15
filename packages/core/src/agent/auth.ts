import { exec } from "node:child_process";
import { promisify } from "node:util";
import { access, constants } from "node:fs/promises";
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
 * Check whether the `claude` binary is on PATH.
 *
 * We shell out to `command -v` / `where` rather than depending on the `which`
 * package — the dependency is overkill for a single existence check.
 */
async function hasClaudeOnPath(): Promise<boolean> {
  const isWindows = process.platform === "win32";
  const probe = isWindows ? "where claude" : "command -v claude";
  try {
    const { stdout } = await execAsync(probe, { windowsHide: true });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Check for the existence of `~/.claude` — the Claude Code config directory
 * that holds an authenticated session.
 */
async function hasClaudeConfigDir(): Promise<boolean> {
  try {
    await access(join(homedir(), ".claude"), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve which Anthropic auth path crashscope should use for this run.
 *
 * Precedence:
 * 1. `config.apiKey` (explicit in CrashscopeConfig)
 * 2. `ANTHROPIC_API_KEY` env var
 * 3. Local Claude Code installation — `claude` binary on PATH **and** a
 *    `~/.claude/` directory present (binary alone isn't enough; the user must
 *    have at least logged in once for the SDK transport to succeed).
 *
 * Throws {@link AuthError} with provider "anthropic" if none of the above are
 * available, so the CLI can render a targeted hint.
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

  const [binary, configDir] = await Promise.all([
    hasClaudeOnPath(),
    hasClaudeConfigDir(),
  ]);
  if (binary && configDir) {
    return { mode: "claude-code" };
  }

  throw new AuthError(
    "anthropic",
    "No Anthropic credentials found. Set ANTHROPIC_API_KEY in your environment, " +
      "provide `anthropic.apiKey` in your crashscope config, or install and log " +
      "into Claude Code (https://claude.com/code) so ~/.claude exists.",
  );
}
