/**
 * Slack Block Kit builders for triage reports and error messages.
 *
 * We don't pull in `@slack/types` to avoid a dependency just for a few JSON
 * shapes; instead, we define a minimal {@link SlackBlock} union covering the
 * blocks we actually emit. Slack accepts any unknown extra fields, so the
 * shapes only need to be a superset-safe subset.
 *
 * Output is intentionally compact: Slack messages have a 50-block limit and
 * rendering 30 fat issue cards is unreadable. We cap at the top 5 issues and
 * indicate overflow.
 */
import type { TriageIssue, TriageReport } from "@pradhankukiran/crashscope-core";

/** Maximum issues rendered inline; the rest are summarized as a count. */
const TOP_N = 5;

/* ---------------------------------------------------------------------------
 * Block-kit shapes (minimal — we only emit a small subset).
 * ------------------------------------------------------------------------- */

interface TextObject {
  type: "plain_text" | "mrkdwn";
  text: string;
  emoji?: boolean;
}

interface HeaderBlock {
  type: "header";
  text: TextObject;
}

interface SectionBlock {
  type: "section";
  text?: TextObject;
  fields?: TextObject[];
  accessory?: ButtonElement;
}

interface DividerBlock {
  type: "divider";
}

interface ContextBlock {
  type: "context";
  elements: TextObject[];
}

interface ButtonElement {
  type: "button";
  text: TextObject;
  url?: string;
  action_id?: string;
  style?: "primary" | "danger";
}

interface ActionsBlock {
  type: "actions";
  elements: ButtonElement[];
}

export type SlackBlock =
  | HeaderBlock
  | SectionBlock
  | DividerBlock
  | ContextBlock
  | ActionsBlock;

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

/** Compose a mrkdwn text object, truncating to Slack's 3000-char per-text cap. */
function md(text: string): TextObject {
  const safe = text.length > 3000 ? text.slice(0, 2997) + "..." : text;
  return { type: "mrkdwn", text: safe };
}

/** Compose a plain-text object, truncating to Slack's 150-char header cap. */
function plain(text: string, cap = 150): TextObject {
  const safe = text.length > cap ? text.slice(0, cap - 3) + "..." : text;
  return { type: "plain_text", text: safe, emoji: true };
}

/** Slack emoji prefix per severity. */
function severityEmoji(sev: TriageIssue["severity"]): string {
  switch (sev) {
    case "fatal":
      return ":rotating_light:";
    case "error":
      return ":red_circle:";
    case "warning":
      return ":large_yellow_circle:";
    case "info":
      return ":information_source:";
    default:
      return ":grey_question:";
  }
}

/** Render `confidence` as a short, sortable tag. */
function confidenceTag(c: TriageIssue["confidence"]): string {
  switch (c) {
    case "high":
      return ":white_check_mark: High confidence";
    case "med":
      return ":warning: Medium confidence";
    case "low":
      return ":grey_question: Low confidence";
  }
}

/** One section block per issue. Includes accessory button when source URL set. */
function issueBlocks(issue: TriageIssue): SlackBlock[] {
  const headerLine =
    `${severityEmoji(issue.severity)} *<${issue.sourceUrl}|${issue.title || issue.errorId}>*`;
  const meta =
    `${issue.affectedUsers.toLocaleString()} users · ${issue.eventCount.toLocaleString()} events · ` +
    `${issue.environment ?? "unknown env"}${issue.releaseVersion ? ` @ ${issue.releaseVersion}` : ""}`;

  const sectionLines: string[] = [
    headerLine,
    meta,
    "",
    `*Hypothesis:* ${issue.hypothesis}`,
    `*Root cause guess:* ${issue.rootCauseGuess}`,
    `*User journey:* ${issue.userJourney}`,
  ];
  if (issue.suggestedFiles.length > 0) {
    sectionLines.push(
      `*Suggested files:* ${issue.suggestedFiles
        .slice(0, 5)
        .map((f) => `\`${f}\``)
        .join(", ")}`,
    );
  }

  const section: SectionBlock = {
    type: "section",
    text: md(sectionLines.join("\n")),
  };
  if (issue.replayUrl) {
    section.accessory = {
      type: "button",
      text: plain("View replay", 75),
      url: issue.replayUrl,
      action_id: `view_replay_${issue.errorId}`,
    };
  }

  const blocks: SlackBlock[] = [
    section,
    {
      type: "context",
      elements: [md(confidenceTag(issue.confidence))],
    },
    { type: "divider" },
  ];
  return blocks;
}

/* ---------------------------------------------------------------------------
 * Public builders
 * ------------------------------------------------------------------------- */

/**
 * Build a Slack message body for a {@link TriageReport}.
 *
 * Renders header + summary + the top N issues. Returns plain JSON-serialisable
 * blocks; callers pass them as the `blocks` field of the Slack response.
 */
export function buildTriageReportBlocks(report: TriageReport): SlackBlock[] {
  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: plain(`Crashscope triage — ${report.window}`),
    },
    {
      type: "section",
      fields: [
        md(`*Total*\n${report.summary.total}`),
        md(`*High*\n${report.summary.high}`),
        md(`*Medium*\n${report.summary.med}`),
        md(`*Low*\n${report.summary.low}`),
      ],
    },
    {
      type: "context",
      elements: [
        md(
          `via _${report.meta.errorProvider}_ + _${report.meta.sessionProvider}_ in ${report.meta.durationMs}ms`,
        ),
      ],
    },
    { type: "divider" },
  ];

  if (report.issues.length === 0) {
    blocks.push({
      type: "section",
      text: md(":sparkles: No issues triaged in this window — all clear."),
    });
    return blocks;
  }

  const top = report.issues.slice(0, TOP_N);
  for (const issue of top) {
    blocks.push(...issueBlocks(issue));
  }

  const overflow = report.issues.length - top.length;
  if (overflow > 0) {
    blocks.push({
      type: "context",
      elements: [
        md(
          `_${overflow} more issue${overflow === 1 ? "" : "s"} not shown. Use the API or CLI for the full report._`,
        ),
      ],
    });
  }

  return blocks;
}

/**
 * Build a Slack message body describing an error during triage.
 *
 * Used both when the user runs `/triage` and we fail before completing, and
 * when the response_url callback wants to replace the loading message.
 */
export function buildErrorBlocks(error: {
  message: string;
  requestId?: string;
}): SlackBlock[] {
  const lines = [
    ":x: *Crashscope triage failed*",
    "",
    `> ${error.message}`,
  ];
  if (error.requestId) {
    lines.push("", `_request id: \`${error.requestId}\`_`);
  }
  return [
    {
      type: "section",
      text: md(lines.join("\n")),
    },
  ];
}
