import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Default file name we write under the chosen config directory.
 *
 * Stored as JSON (not YAML/TOML) because the consuming module is plain `JSON`
 * and a single dependency-free format keeps the CLI bootstrap surface small.
 */
const CONFIG_FILE_NAME = "config.json";

/**
 * Directory name relative to the user's XDG / home root.
 *
 * We use a literal directory rather than respecting `$CRASHSCOPE_HOME` etc.;
 * one well-known location keeps the support story simple and makes
 * `crashscope config path` deterministic.
 */
const CONFIG_DIR_NAME = "crashscope";

/**
 * Resolve the directory that should hold `config.json`.
 *
 * Precedence:
 * 1. `$XDG_CONFIG_HOME/crashscope` when `XDG_CONFIG_HOME` is non-empty
 *    (typical on Linux desktop installs and inside dev containers).
 * 2. `~/.crashscope` otherwise — the documented default in the README.
 *
 * Note: returning a *directory*, not the file path. Callers join the filename
 * via {@link getConfigPath} so save/load stays single-sourced.
 */
export function getConfigDir(): string {
  const xdg = process.env["XDG_CONFIG_HOME"]?.trim();
  if (xdg && xdg.length > 0) {
    return join(xdg, CONFIG_DIR_NAME);
  }
  return join(homedir(), `.${CONFIG_DIR_NAME}`);
}

/**
 * Resolve the full path to the crashscope config file.
 *
 * Callers should treat this as the canonical location; the {@link load} module
 * will accept a CLI `--config` override that bypasses this entirely.
 */
export function getConfigPath(): string {
  return join(getConfigDir(), CONFIG_FILE_NAME);
}

/**
 * Path to the optional debug log emitted when the user passes `--debug`.
 */
export function getDebugLogPath(): string {
  return join(getConfigDir(), "debug.log");
}
