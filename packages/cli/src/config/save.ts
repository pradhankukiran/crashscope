import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ConfigError,
  ValidationError,
  crashscopeConfigSchema,
  type CrashscopeConfig,
} from "@crashscope/core";
import { getConfigPath } from "./paths.js";

/**
 * File permission mode used for `config.json`.
 *
 * `0o600` (user-rw, no group/other access) is the conservative default for a
 * file that contains API tokens. We always re-apply this after writing —
 * `writeFile` would otherwise honour the process umask which, on some
 * developer machines, leaves the file world-readable.
 */
const FILE_MODE = 0o600;

/**
 * Persist `config` to disk at `path` (or the canonical location).
 *
 * The function:
 * 1. Re-validates against {@link crashscopeConfigSchema} as a belt-and-braces
 *    check so we never write a config that `loadConfig` would later reject.
 * 2. Creates the containing directory (recursively) if it does not exist.
 * 3. Writes with pretty (2-space) JSON indentation and a trailing newline so
 *    the file plays nicely with `EDITOR` and `git diff`.
 * 4. Chmods the file to {@link FILE_MODE} to keep credentials private.
 */
export async function saveConfig(
  config: CrashscopeConfig,
  path?: string,
): Promise<string> {
  const result = crashscopeConfigSchema.safeParse(config);
  if (!result.success) {
    throw new ValidationError(
      "Refusing to write invalid config — fix the issues below and retry.",
      result.error,
    );
  }

  const resolved = path ?? getConfigPath();
  try {
    await mkdir(dirname(resolved), { recursive: true, mode: 0o700 });
  } catch (err: unknown) {
    const cause = err instanceof Error ? err : new Error(String(err));
    throw new ConfigError(
      `Failed to create config directory ${dirname(resolved)}: ${cause.message}`,
      { cause },
    );
  }

  const body = JSON.stringify(result.data, null, 2) + "\n";
  try {
    await writeFile(resolved, body, { encoding: "utf8", mode: FILE_MODE });
    // chmod is a no-op on platforms (e.g. Windows) that ignore POSIX bits, but
    // calling it remains harmless and ensures correctness on POSIX hosts even
    // when the file pre-existed with a more permissive mode.
    await chmod(resolved, FILE_MODE);
  } catch (err: unknown) {
    const cause = err instanceof Error ? err : new Error(String(err));
    throw new ConfigError(
      `Failed to write config to ${resolved}: ${cause.message}`,
      { cause },
    );
  }
  return resolved;
}
