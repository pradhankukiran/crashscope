import chalk from "chalk";
import boxen from "boxen";
import type {
  Severity,
  TriageIssue,
  TriageReport,
} from "@pradhankukiran/crashscope-core";

/**
 * Width reserved for the label column of each field row.
 *
 * Eleven characters fits "Hypothesis", "User flow", "Suggested" and the other
 * longest labels we use — plus a single trailing space — so the value column
 * starts at a consistent offset of 12.
 */
const LABEL_WIDTH = 11;

/**
 * Sensible fallback when the terminal does not report a width (e.g. piping
 * `crashscope triage` into `cat`). 100 columns is wide enough to render the
 * sample box from the README without wrapping mid-field.
 */
const DEFAULT_TERMINAL_WIDTH = 100;

/**
 * Hard floor on usable width — anything narrower and we stop trying to
 * pretty-format and just dump unwrapped lines. This avoids `wrap()` infinite
 * loops on degenerate widths and keeps headless CI tail logs readable.
 */
const MIN_USABLE_WIDTH = 40;

/**
 * Map a normalized {@link Severity} onto the colour helpers and emoji used in
 * box headers and the summary line.
 *
 * Kept as a small lookup table rather than a switch so the same data drives
 * both the header style and the summary tallies — single source of truth.
 */
interface SeverityStyle {
  readonly emoji: string;
  readonly label: string;
  readonly colorize: (s: string) => string;
  /** Bucket used for summary aggregation (high/med/low). */
  readonly bucket: "high" | "med" | "low";
}

const SEVERITY_STYLE: Record<Severity, SeverityStyle> = {
  fatal: {
    emoji: "🔴",
    label: "HIGH",
    colorize: (s) => chalk.red.bold(s),
    bucket: "high",
  },
  error: {
    emoji: "🔴",
    label: "HIGH",
    colorize: (s) => chalk.red.bold(s),
    bucket: "high",
  },
  warning: {
    emoji: "🟡",
    label: "MED",
    colorize: (s) => chalk.yellow.bold(s),
    bucket: "med",
  },
  info: {
    emoji: "🔵",
    label: "LOW",
    colorize: (s) => chalk.gray.bold(s),
    bucket: "low",
  },
};

/**
 * Detect the current TTY width with a conservative fallback.
 *
 * Reads `process.stdout.columns` rather than `tty.getWindowSize` so it works
 * in the same way as `boxen` and `ora`. When that value is missing (piped
 * output, redirected streams), we fall back to {@link DEFAULT_TERMINAL_WIDTH}.
 */
function getTerminalWidth(): number {
  const cols = process.stdout.columns;
  if (typeof cols === "number" && cols > 0) return cols;
  return DEFAULT_TERMINAL_WIDTH;
}

/**
 * Wrap a string at `width` characters on whitespace boundaries.
 *
 * We avoid pulling in `wordwrap`/`cliui` — those are tens of KB for a single
 * call site. This implementation is deliberately naive: it splits on spaces,
 * then greedy-packs words into lines. Long unbreakable tokens (URLs, file
 * paths) are emitted on their own line rather than truncated.
 */
function wrap(text: string, width: number): string[] {
  if (width < MIN_USABLE_WIDTH) return text.split("\n");
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
      } else if (line.length + 1 + word.length <= width) {
        line += " " + word;
      } else {
        out.push(line);
        line = word;
      }
    }
    if (line.length > 0) out.push(line);
  }
  return out;
}

/**
 * Format a single label/value pair as one (or more) wrapped lines.
 *
 * The first line shows the label padded to {@link LABEL_WIDTH}; continuation
 * lines indent to the same column so multi-line values stay visually attached
 * to their label.
 */
function field(label: string, value: string, valueWidth: number): string {
  const paddedLabel = label.padEnd(LABEL_WIDTH, " ");
  const blankLabel = " ".repeat(LABEL_WIDTH);
  const lines = wrap(value, Math.max(MIN_USABLE_WIDTH, valueWidth));
  if (lines.length === 0) {
    return `${chalk.dim(paddedLabel)} `;
  }
  const headLine = `${chalk.dim(paddedLabel)} ${lines[0] ?? ""}`;
  if (lines.length === 1) return headLine;
  const rest = lines
    .slice(1)
    .map((l) => `${blankLabel} ${l}`)
    .join("\n");
  return `${headLine}\n${rest}`;
}

/**
 * Render a single timestamp pair into a "last 1h"-style relative summary.
 *
 * Anchored to `now` so the function is testable; the caller in {@link render}
 * passes `Date.now()`.
 */
function relativeSince(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diffMs = Math.max(0, now - t);
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

/**
 * Build the "Affected" line: "23 users · 47 events · last 1h".
 */
function affectedLine(issue: TriageIssue, now: number): string {
  return [
    `${issue.affectedUsers} users`,
    `${issue.eventCount} events`,
    `last ${relativeSince(issue.lastSeen, now)}`,
  ].join(" · ");
}

/**
 * Render one issue as a multi-line block ready for stdout.
 *
 * Returns a string (not a `boxen` call) because the report header / divider
 * style is owned by {@link renderReport}; per-issue boxes inside `boxen`
 * would compete with the outer frame and add unnecessary visual noise.
 */
function renderIssue(issue: TriageIssue, terminalWidth: number, now: number): string {
  const style = SEVERITY_STYLE[issue.severity];
  const rule = chalk.gray("─".repeat(Math.min(terminalWidth, 60)));
  const titleLine = `${style.emoji}  ${style.colorize(style.label)}  ${chalk.bold(issue.title)}`;
  const valueWidth = Math.max(MIN_USABLE_WIDTH, terminalWidth - LABEL_WIDTH - 2);

  const rows: string[] = [
    rule,
    titleLine,
    rule,
    field("Affected", affectedLine(issue, now), valueWidth),
  ];
  if (issue.releaseVersion) {
    rows.push(
      field(
        "New since",
        `${issue.releaseVersion} (last seen ${relativeSince(issue.lastSeen, now)} ago)`,
        valueWidth,
      ),
    );
  }
  rows.push(field("User flow", issue.userJourney, valueWidth));
  rows.push(field("Hypothesis", issue.hypothesis, valueWidth));
  rows.push(field("Root cause", issue.rootCauseGuess, valueWidth));
  if (issue.suggestedFiles.length > 0) {
    rows.push(field("Check", issue.suggestedFiles.join(", "), valueWidth));
  }
  if (issue.replayUrl) {
    rows.push(field("Replay", issue.replayUrl, valueWidth));
  }
  rows.push(
    field(
      providerLabel(issue.provider),
      issue.sourceUrl,
      valueWidth,
    ),
  );
  rows.push(field("Confidence", confidenceLabel(issue.confidence), valueWidth));
  return rows.join("\n");
}

/** Capitalize a provider id for the "Sentry" / "Rollbar" / etc. label. */
function providerLabel(provider: string): string {
  if (provider.length === 0) return provider;
  return provider[0]!.toUpperCase() + provider.slice(1);
}

/**
 * Format the model's confidence into a colour-tinted word so the user picks
 * it out without having to read every label.
 */
function confidenceLabel(c: TriageIssue["confidence"]): string {
  switch (c) {
    case "high":
      return chalk.green("high");
    case "med":
      return chalk.yellow("med");
    case "low":
      return chalk.gray("low");
  }
}

/**
 * Compute summary tallies from a list of issues.
 *
 * We re-bucket here rather than trusting any incoming `summary` field — the
 * caller may pass a synthetic report (e.g. a filtered subset).
 */
function computeSummary(issues: readonly TriageIssue[]): {
  high: number;
  med: number;
  low: number;
  total: number;
} {
  let high = 0;
  let med = 0;
  let low = 0;
  for (const issue of issues) {
    const bucket = SEVERITY_STYLE[issue.severity].bucket;
    if (bucket === "high") high++;
    else if (bucket === "med") med++;
    else low++;
  }
  return { high, med, low, total: issues.length };
}

/**
 * Render the full {@link TriageReport} as the string we will print to stdout.
 *
 * The output begins with a `boxen`-wrapped header so the window/provider/run
 * metadata is unmistakable, then each issue, then a one-line summary. The
 * return value is newline-terminated so callers can `process.stdout.write`
 * directly.
 */
export function renderTerminalReport(report: TriageReport): string {
  const terminalWidth = getTerminalWidth();
  const now = Date.now();

  const headerLines = [
    chalk.bold(`crashscope · ${report.window}`),
    chalk.dim(
      `${report.meta.errorProvider} → ${report.meta.sessionProvider} · ${report.issues.length} issues`,
    ),
  ];
  const header = boxen(headerLines.join("\n"), {
    padding: { top: 0, bottom: 0, left: 1, right: 1 },
    borderStyle: "round",
    borderColor: "gray",
    width: Math.min(terminalWidth, 80),
  });

  const blocks: string[] = [header];
  if (report.issues.length === 0) {
    blocks.push(
      chalk.dim("\nNo issues matched the requested window and filters."),
    );
  } else {
    for (const issue of report.issues) {
      blocks.push("");
      blocks.push(renderIssue(issue, terminalWidth, now));
    }
  }

  const summary = computeSummary(report.issues);
  const durationSec = Math.max(0, Math.round(report.meta.durationMs / 1000));
  blocks.push("");
  blocks.push(
    chalk.bold("Summary: ") +
      [
        `${summary.total} issues`,
        `${summary.high} high`,
        `${summary.med} med`,
        `${summary.low} low`,
      ].join(" · "),
  );
  blocks.push(chalk.dim(`Done in ${durationSec}s.`));
  return blocks.join("\n") + "\n";
}

/**
 * Side-effecting variant: write the rendered report straight to stdout.
 *
 * Centralised here so `commands/triage.ts` doesn't import `process.stdout`
 * directly; tests can swap this for an in-memory writer later.
 */
export function printTerminalReport(report: TriageReport): void {
  process.stdout.write(renderTerminalReport(report));
}
