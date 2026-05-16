import { writeFile } from "node:fs/promises";
import { extname } from "node:path";
import type { TriageReport } from "@crashscope/core";
import { renderJsonReport } from "./json.js";
import { renderMarkdownReport } from "./markdown.js";
import { renderTerminalReport } from "./terminal.js";

/**
 * Output formats supported by `crashscope triage --out`.
 *
 * `terminal` writes a rendering identical to the TTY output (ANSI escape
 * codes included). Most users will pair `--out report.md` with markdown, or
 * `--out report.json` with JSON; the terminal variant is mostly for
 * snapshot-style debugging.
 */
export type FileFormat = "md" | "json" | "terminal";

/**
 * Resolve a {@link FileFormat} from the destination path's extension.
 *
 * Returns `null` when the extension isn't recognised so the caller can fall
 * back to whatever `--format` the user passed or surface a clear error.
 */
export function formatFromExtension(path: string): FileFormat | null {
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case ".md":
    case ".markdown":
      return "md";
    case ".json":
      return "json";
    case ".txt":
      return "terminal";
    default:
      return null;
  }
}

/**
 * Render `report` according to `format`, returning the byte-ready string.
 *
 * Kept separate from {@link writeReportToFile} so callers (e.g. tests) can
 * inspect the rendered output without touching the filesystem.
 */
export function renderReport(
  report: TriageReport,
  format: FileFormat,
): string {
  switch (format) {
    case "md":
      return renderMarkdownReport(report);
    case "json":
      return renderJsonReport(report);
    case "terminal":
      return renderTerminalReport(report);
  }
}

/**
 * Write `report` to `path` in the requested format.
 *
 * `fs.promises.writeFile` is used directly — by design, we do not create
 * missing parent directories. The caller (typically `crashscope triage`)
 * surfaces the resulting ENOENT clearly so a user typo doesn't silently
 * mkdir an unexpected tree.
 *
 * Returns the path written so the caller can echo it back to the user.
 */
export async function writeReportToFile(
  report: TriageReport,
  path: string,
  format: FileFormat,
): Promise<string> {
  const body = renderReport(report, format);
  await writeFile(path, body, { encoding: "utf8" });
  return path;
}
