import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ConfigError,
  ValidationError,
  crashscopeConfigSchema,
  type CrashscopeConfig,
} from "@pradhankukiran/crashscope-core";
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
 * Suffix used for the temporary file written before the atomic rename.
 *
 * Keeping the temp file next to the destination guarantees the rename happens
 * on the same filesystem — `rename(2)` across filesystems is non-atomic. The
 * `.tmp` extension also discourages other tools (editors, `git`) from picking
 * the file up as a real config.
 */
const TMP_SUFFIX = ".tmp";

/**
 * Persist `config` to disk at `path` (or the canonical location).
 *
 * The function:
 * 1. Re-validates against {@link crashscopeConfigSchema} as a belt-and-braces
 *    check so we never write a config that `loadConfig` would later reject.
 * 2. Creates the containing directory (recursively) if it does not exist.
 * 3. Writes to `<path>.tmp` with mode {@link FILE_MODE} (chmod is applied
 *    explicitly because Node honours the process umask on the initial write
 *    on some platforms).
 * 4. `fs.rename`s the temp file over the destination. POSIX `rename(2)` is
 *    atomic for same-filesystem destinations, so a `SIGINT` mid-write leaves
 *    the previous config intact instead of truncating it.
 *
 * On failure we unlink the temp file (best-effort) so a half-written `.tmp`
 * doesn't accumulate after a partial run.
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
  const tmp = resolved + TMP_SUFFIX;
  try {
    await writeFile(tmp, body, { encoding: "utf8", mode: FILE_MODE });
    // chmod is a no-op on platforms (e.g. Windows) that ignore POSIX bits, but
    // calling it remains harmless and ensures correctness on POSIX hosts even
    // when the temp file pre-existed with a more permissive mode.
    await chmod(tmp, FILE_MODE);
    // Atomic publish — readers see either the old config or the new one,
    // never a half-written buffer.
    await rename(tmp, resolved);
  } catch (err: unknown) {
    // Best-effort cleanup of the temp file. We swallow ENOENT here because
    // the temp may never have been created (e.g. EACCES on writeFile) and we
    // don't want a follow-on error to mask the real one.
    try {
      await unlink(tmp);
    } catch {
      // Ignore — see comment above.
    }
    const cause = err instanceof Error ? err : new Error(String(err));
    throw new ConfigError(
      `Failed to write config to ${resolved}: ${cause.message}`,
      { cause },
    );
  }
  return resolved;
}
