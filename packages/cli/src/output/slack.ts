import { AdapterError } from "@crashscope/core";
import type {
  CrashscopeConfig,
  Severity,
  TriageIssue,
  TriageReport,
} from "@crashscope/core";

/**
 * Maximum length permitted by Slack's `section` block `text` field.
 *
 * The real Slack limit is 3000 characters; we leave a small headroom so the
 * truncation marker can be appended without overflowing.
 */
const SECTION_TEXT_LIMIT = 2_900;

/**
 * Slack Block Kit payload shape (the subset we generate).
 *
 * Slack supports many more block variants; we keep our subset tight so the
 * formatter stays simple and so we can hand-roll the types instead of pulling
 * in the official `@slack/types` dependency.
 */
interface SlackBlock {
  type: "header" | "section" | "divider" | "context" | "actions";
  text?: { type: "mrkdwn" | "plain_text"; text: string; emoji?: boolean };
  fields?: Array<{ type: "mrkdwn"; text: string }>;
  elements?: SlackElement[];
}

type SlackElement =
  | { type: "mrkdwn"; text: string }
  | {
      type: "button";
      text: { type: "plain_text"; text: string; emoji?: boolean };
      url: string;
      style?: "primary" | "danger";
    };

interface SlackPayload {
  text: string;
  blocks: SlackBlock[];
}

/** Maps severity → emoji for the section preamble. Mirrors terminal output. */
const SEVERITY_EMOJI: Record<Severity, string> = {
  fatal: ":red_circle:",
  error: ":red_circle:",
  warning: ":large_yellow_circle:",
  info: ":large_blue_circle:",
};

/** Maps severity → human label used in the header / fallback text. */
const SEVERITY_LABEL: Record<Severity, string> = {
  fatal: "HIGH",
  error: "HIGH",
  warning: "MED",
  info: "LOW",
};

/**
 * Slack treats `*foo*` as bold and `_foo_` as italic — both are very easy to
 * trigger accidentally inside hypothesis text. We do the minimal escape that
 * keeps emphasis literal without disturbing URLs / IDs.
 */
function escapeMrkdwn(text: string): string {
  return text.replace(/([*_<>])/g, "\\$1");
}

/** Trim a string to `limit` characters, appending an ellipsis when needed. */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit - 1)) + "…";
}

/**
 * Build the per-issue section block payload.
 *
 * The "fields" array Slack supports is two-column; we use it for the dense
 * metadata (severity, provider, users/events) and keep the prose
 * (hypothesis, journey) in the section `text` so it wraps naturally.
 */
function renderIssueBlocks(issue: TriageIssue): SlackBlock[] {
  const emoji = SEVERITY_EMOJI[issue.severity];
  const label = SEVERITY_LABEL[issue.severity];
  const title = escapeMrkdwn(issue.title);
  const sectionText =
    `${emoji} *${label}* — *${title}*\n` +
    `*Hypothesis:* ${escapeMrkdwn(issue.hypothesis)}\n` +
    `*Root cause:* ${escapeMrkdwn(issue.rootCauseGuess)}\n` +
    `*User journey:* ${escapeMrkdwn(issue.userJourney)}`;

  const fields: Array<{ type: "mrkdwn"; text: string }> = [
    {
      type: "mrkdwn",
      text: `*Affected*\n${issue.affectedUsers} users · ${issue.eventCount} events`,
    },
    {
      type: "mrkdwn",
      text: `*Confidence*\n${issue.confidence}`,
    },
  ];
  if (issue.suggestedFiles.length > 0) {
    fields.push({
      type: "mrkdwn",
      text: `*Check*\n${issue.suggestedFiles
        .map((f) => "`" + escapeMrkdwn(f) + "`")
        .join("\n")}`,
    });
  }
  if (issue.releaseVersion) {
    fields.push({
      type: "mrkdwn",
      text: `*Release*\n${escapeMrkdwn(issue.releaseVersion)}`,
    });
  }

  const actions: SlackElement[] = [
    {
      type: "button",
      text: { type: "plain_text", text: "View error", emoji: true },
      url: issue.sourceUrl,
    },
  ];
  if (issue.replayUrl) {
    actions.push({
      type: "button",
      text: { type: "plain_text", text: "Watch replay", emoji: true },
      url: issue.replayUrl,
    });
  }

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncate(sectionText, SECTION_TEXT_LIMIT),
      },
      fields,
    },
    { type: "actions", elements: actions },
    { type: "divider" },
  ];
}

/**
 * Translate a {@link TriageReport} into a Slack Block Kit payload.
 *
 * The payload includes a `text` field used as the notification preview and
 * fallback for clients that don't render blocks (mobile push notifications,
 * email digests).
 */
export function renderSlackPayload(report: TriageReport): SlackPayload {
  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `crashscope · ${report.summary.total} issues · ${report.window}`,
        emoji: true,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text:
            `*${report.meta.errorProvider}* → *${report.meta.sessionProvider}* · ` +
            `${report.summary.high} high · ${report.summary.med} med · ${report.summary.low} low`,
        },
      ],
    },
    { type: "divider" },
  ];

  for (const issue of report.issues) {
    blocks.push(...renderIssueBlocks(issue));
  }

  const fallback =
    `crashscope: ${report.summary.total} issues in ${report.window} ` +
    `(${report.summary.high} high, ${report.summary.med} med, ${report.summary.low} low)`;

  return { text: fallback, blocks };
}

/**
 * Resolve the Slack webhook URL from the validated config.
 *
 * We currently only support the webhook delivery path (bot tokens require
 * `chat.postMessage` + `channels`, which is a larger surface). Returns `null`
 * when slack output is configured but only `botToken` is present — callers
 * should surface a clear message in that case.
 */
function getWebhookUrl(config: CrashscopeConfig): string | null {
  return config.credentials.slack?.webhookUrl ?? null;
}

/**
 * Deliver a triage report to Slack via the configured webhook.
 *
 * Throws {@link AdapterError} (provider `"slack"`) on transport failures, so
 * the CLI error-handling can map it to a non-zero exit code without leaking
 * the webhook URL into stderr.
 */
export async function postSlackReport(
  report: TriageReport,
  config: CrashscopeConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = getWebhookUrl(config);
  if (!url) {
    throw new AdapterError(
      "slack",
      "Slack output requires credentials.slack.webhookUrl (bot tokens are not yet supported).",
    );
  }

  const payload = renderSlackPayload(report);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err: unknown) {
    const cause = err instanceof Error ? err : new Error(String(err));
    throw new AdapterError(
      "slack",
      `Slack webhook request failed: ${cause.message}`,
      { cause },
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    // Slack returns short text like "invalid_payload" or "no_service" — safe
    // to embed in the error. We deliberately don't echo the webhook URL.
    throw new AdapterError(
      "slack",
      `Slack webhook rejected delivery (HTTP ${response.status}): ${body.slice(0, 200)}`,
    );
  }
}
