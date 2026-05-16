import type { TriageReport } from "@pradhankukiran/crashscope-core";

/**
 * Indentation used by {@link renderJsonReport} when `compact` is false.
 *
 * Two-space indent matches the rest of the repo and avoids the visual mass
 * of a four-space dump on terminals that don't soft-wrap.
 */
const PRETTY_INDENT = 2;

export interface JsonRenderOptions {
  /** Emit compact (single-line) JSON instead of pretty-printed. */
  readonly compact?: boolean;
}

/**
 * Serialize a {@link TriageReport} to JSON.
 *
 * The output is identical to `JSON.stringify(report)` semantically; the only
 * variation is whitespace. We keep a dedicated module so the entry-point
 * doesn't reach into `JSON.stringify` directly — when callers eventually want
 * NDJSON or stable key ordering we have exactly one place to touch.
 *
 * Always terminated with a trailing newline so piped consumers
 * (e.g. `crashscope triage --json | jq`) get a clean record boundary.
 */
export function renderJsonReport(
  report: TriageReport,
  options: JsonRenderOptions = {},
): string {
  const body = options.compact
    ? JSON.stringify(report)
    : JSON.stringify(report, null, PRETTY_INDENT);
  return body + "\n";
}

/**
 * Side-effecting helper: write the JSON report to stdout.
 *
 * Tests can swap the underlying writer by calling {@link renderJsonReport}
 * directly and piping the string elsewhere; production code uses this helper
 * so the CLI doesn't import `process.stdout` ad-hoc.
 */
export function printJsonReport(
  report: TriageReport,
  options: JsonRenderOptions = {},
): void {
  process.stdout.write(renderJsonReport(report, options));
}
