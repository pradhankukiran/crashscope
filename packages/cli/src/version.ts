import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Resolve the CLI's package version at runtime by reading `package.json`.
 *
 * Reading from disk (rather than a generated constant) means the published
 * version stays accurate after `npm version` bumps without a rebuild step.
 * The lookup walks up from the compiled module's directory so it works both
 * when running from `dist/` and when invoked via the `bin/crashscope` shim.
 */
function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // `dist/version.js` → `..` is the package root containing `package.json`.
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    if (typeof pkg.version === "string" && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch {
    // Fall through to the conservative default.
  }
  return "0.0.0";
}

/** The CLI's semantic version, resolved at first import. */
export const VERSION: string = readPackageVersion();
