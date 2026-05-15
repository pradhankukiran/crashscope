import { readFile } from "node:fs/promises";
import {
  ConfigError,
  ValidationError,
  crashscopeConfigSchema,
  type CrashscopeConfig,
} from "@crashscope/core";
import { getConfigPath } from "./paths.js";

/**
 * Read and validate the crashscope config from disk.
 *
 * Failure modes are deliberately separated:
 * - {@link ConfigError}: file missing, unreadable, or not valid JSON. The CLI
 *   surfaces this with a "run `crashscope init`" hint.
 * - {@link ValidationError}: JSON parsed but did not match
 *   {@link crashscopeConfigSchema}. The CLI prints the per-issue zod path so
 *   the user can fix the file by hand.
 *
 * `path` defaults to the canonical {@link getConfigPath}; pass through the
 * `--config` flag to load from an alternate location.
 */
export async function loadConfig(path?: string): Promise<CrashscopeConfig> {
  const resolved = path ?? getConfigPath();

  let raw: string;
  try {
    raw = await readFile(resolved, "utf8");
  } catch (err: unknown) {
    const cause = err instanceof Error ? err : new Error(String(err));
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError(
        `No crashscope config found at ${resolved}. Run \`crashscope init\` to create one.`,
        { cause },
      );
    }
    throw new ConfigError(
      `Failed to read crashscope config at ${resolved}: ${cause.message}`,
      { cause },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    const cause = err instanceof Error ? err : new Error(String(err));
    throw new ConfigError(
      `Config at ${resolved} is not valid JSON: ${cause.message}`,
      { cause },
    );
  }

  const result = crashscopeConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ValidationError(
      `Config at ${resolved} failed schema validation.`,
      result.error,
    );
  }
  return result.data;
}
