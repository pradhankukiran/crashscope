import type {
  Severity,
  TriageIssue,
  TriageReport,
} from "@crashscope/core";

/**
 * Soft column target used for wrapped prose. Markdown is paste-friendly even
 * at 100 columns, but most issue trackers (GitHub, Linear) render compose
 * boxes around 70–80 chars; staying under 80 keeps the source view readable.
 */
const COLUMN_TARGET = 80;

/**
 * Map normalized severities to a leading emoji + label.
 *
 * The emoji is the same one terminal output uses so the markdown and TTY
 * surfaces tell the same visual story.
 */
const SEVERITY_BADGE: Record<Severity, { emoji: string; label: string }> = {
  fatal: { emoji: "🔴", label: "HIGH" },
  error: { emoji: "🔴", label: "HIGH" },
  warning: { emoji: "🟡", label: "MED" },
  info: { emoji: "🔵", label: "LOW" },
};

/**
 * Wrap a paragraph to {@link COLUMN_TARGET} columns on whitespace boundaries.
 *
 * Tokens longer than the target column (e.g. long URLs or filenames) are
 * emitted on their own line rather than truncated. Newlines in the input
 * survive verbatim so the helper composes cleanly with multi-line input.
 */
function wrap(text: string, columns: number = COLUMN_TARGET): string {
  if (text.length === 0) return text;
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      out.push("");
      continue;
    }
    const words = paragraph.split(/\s+/);
    let line = "";
    for (const word of words) {
      if (line.length === 0) {
        line = word;
      } else if (line.length + 1 + word.length <= columns) {
        line += " " + word;
      } else {
        out.push(line);
        line = word;
      }
    }
    if (line.length > 0) out.push(line);
  }
  return out.join("\n");
}

/**
 * Markdown-escape a string used inside a heading or table cell.
 *
 * The destination platforms (GitHub, Linear) interpret a handful of
 * characters specially in inline contexts; we escape just enough to keep
 * the visible text faithful without making the source unreadable.
 */
function escapeInline(text: string): string {
  return text.replace(/([\\`*_{}\[\]()#+!])/g, "\\$1");
}

/**
 * Render a single issue as a markdown block.
 *
 * The block uses an `H2` heading so multi-issue reports render with a clean
 * table of contents in tools that auto-generate one (GitHub, Notion, etc.).
 */
function renderIssue(issue: TriageIssue, index: number, total: number): string {
  const badge = SEVERITY_BADGE[issue.severity];
  const lines: string[] = [];
  lines.push(
    `## ${badge.emoji} ${badge.label} — ${escapeInline(issue.title)} (${index + 1}/${total})`,
  );
  lines.push("");
  lines.push(
    `- **Provider:** ${escapeInline(issue.provider)}` +
      `${issue.environment ? ` · **Env:** ${escapeInline(issue.environment)}` : ""}` +
      `${issue.releaseVersion ? ` · **Release:** \`${escapeInline(issue.releaseVersion)}\`` : ""}`,
  );
  lines.push(
    `- **Affected:** ${issue.affectedUsers} users · ${issue.eventCount} events`,
  );
  lines.push(
    `- **First seen:** ${issue.firstSeen} · **Last seen:** ${issue.lastSeen}`,
  );
  lines.push(`- **Confidence:** \`${issue.confidence}\``);
  lines.push("");
  lines.push("### Hypothesis");
  lines.push(wrap(issue.hypothesis));
  lines.push("");
  lines.push("### Root cause");
  lines.push(wrap(issue.rootCauseGuess));
  lines.push("");
  lines.push("### User journey");
  lines.push(wrap(issue.userJourney));
  if (issue.suggestedFiles.length > 0) {
    lines.push("");
    lines.push("### Suggested files");
    for (const file of issue.suggestedFiles) {
      lines.push(`- \`${file}\``);
    }
  }
  lines.push("");
  lines.push("### Links");
  lines.push(`- [View error](${issue.sourceUrl})`);
  if (issue.replayUrl) {
    lines.push(`- [Watch replay](${issue.replayUrl})`);
  }
  if (issue.sessionId) {
    lines.push(`- Session id: \`${issue.sessionId}\``);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Render a {@link TriageReport} as a paste-friendly Markdown document.
 *
 * Layout:
 *   - Title with the report window.
 *   - Summary table (high / med / low / total).
 *   - One H2 section per issue.
 *
 * The output is newline-terminated so the caller can pipe to a file without
 * worrying about a trailing-newline mismatch.
 */
export function renderMarkdownReport(report: TriageReport): string {
  const lines: string[] = [];
  lines.push(`# crashscope · ${escapeInline(report.window)}`);
  lines.push("");
  lines.push(
    `Generated at ${report.generatedAt} · ` +
      `${escapeInline(report.meta.errorProvider)} → ${escapeInline(report.meta.sessionProvider)} · ` +
      `${Math.max(0, Math.round(report.meta.durationMs / 1000))}s`,
  );
  lines.push("");
  lines.push("| Severity | Count |");
  lines.push("| -------- | ----- |");
  lines.push(`| HIGH     | ${report.summary.high} |`);
  lines.push(`| MED      | ${report.summary.med} |`);
  lines.push(`| LOW      | ${report.summary.low} |`);
  lines.push(`| **Total** | **${report.summary.total}** |`);
  lines.push("");
  if (report.issues.length === 0) {
    lines.push(
      "_No issues matched the requested window and filters._",
    );
    lines.push("");
    return lines.join("\n");
  }
  for (let i = 0; i < report.issues.length; i++) {
    const issue = report.issues[i];
    if (!issue) continue;
    lines.push(renderIssue(issue, i, report.issues.length));
  }
  return lines.join("\n");
}
