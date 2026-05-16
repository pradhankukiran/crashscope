import { AdapterError } from "@pradhankukiran/crashscope-core";
import type {
  CrashscopeConfig,
  Severity,
  TriageIssue,
  TriageReport,
} from "@pradhankukiran/crashscope-core";

/**
 * Maximum length permitted by Slack's `section` block `text` field.
 *
 * The real Slack limit is 3000 characters; we leave a small headroom so the
 * truncation marker can be appended without overflowing.
 */
const SECTION_TEXT_LIMIT = 2_900;

/**
 * Slack rejects payloads with more than 50 blocks. Each issue renders to 3
 * blocks (section + actions + divider) so without chunking the cap is hit
 * around 16 issues. We leave a small headroom (2 blocks) so the per-chunk
 * preamble (divider on continuation chunks, header+context+divider on the
 * first chunk) stays inside the budget.
 */
const SLACK_BLOCK_LIMIT = 50;

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

/**
 * Return `url` when it's a non-empty http(s) URL, otherwise `null`.
 *
 * Slack's action buttons reject anything that isn't an http(s) URL with an
 * `invalid_url` error and the whole payload is dropped, so we filter here
 * rather than letting Slack reject the message entirely. Using the WHATWG
 * `URL` parser also catches malformed strings (e.g. a stray space) that
 * regex-based checks would miss.
 */
function safeHttpUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string" || url.length === 0) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return url;
    }
    return null;
  } catch {
    return null;
  }
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

  // Slack rejects buttons whose `url` isn't a valid http(s) URL. We omit any
  // button whose source link fails the scheme check so a single bad URL never
  // takes down the whole report delivery.
  const actions: SlackElement[] = [];
  const sourceUrl = safeHttpUrl(issue.sourceUrl);
  if (sourceUrl !== null) {
    actions.push({
      type: "button",
      text: { type: "plain_text", text: "View error", emoji: true },
      url: sourceUrl,
    });
  }
  const replayUrl = safeHttpUrl(issue.replayUrl);
  if (replayUrl !== null) {
    actions.push({
      type: "button",
      text: { type: "plain_text", text: "Watch replay", emoji: true },
      url: replayUrl,
    });
  }

  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncate(sectionText, SECTION_TEXT_LIMIT),
      },
      fields,
    },
  ];
  if (actions.length > 0) {
    blocks.push({ type: "actions", elements: actions });
  }
  blocks.push({ type: "divider" });
  return blocks;
}

/**
 * Translate a {@link TriageReport} into a single Slack Block Kit payload.
 *
 * The payload includes a `text` field used as the notification preview and
 * fallback for clients that don't render blocks (mobile push notifications,
 * email digests).
 *
 * Callers delivering the report should prefer {@link renderSlackPayloadChunks}
 * which chunks long reports to stay inside Slack's 50-block-per-payload cap.
 */
export function renderSlackPayload(report: TriageReport): SlackPayload {
  const chunks = renderSlackPayloadChunks(report);
  // The single-payload helper is retained for tests and for callers that
  // explicitly want the un-chunked form. Most callers should iterate
  // `renderSlackPayloadChunks`.
  if (chunks.length === 0) {
    // Defensive: chunker should always emit at least the header chunk.
    return {
      text: fallbackText(report),
      blocks: headerBlocks(report),
    };
  }
  // Concatenate so legacy callers still see one payload with all blocks even
  // if it exceeds Slack's limit — the new chunked path is the supported one.
  const merged: SlackBlock[] = [];
  for (const chunk of chunks) merged.push(...chunk.blocks);
  return { text: fallbackText(report), blocks: merged };
}

/**
 * Build the header blocks shared by every payload chunk (header, context,
 * divider). Kept as a separate helper because the first chunk includes them
 * inline while continuation chunks don't.
 */
function headerBlocks(report: TriageReport): SlackBlock[] {
  return [
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
}

/**
 * Notification preview / fallback text used on every payload.
 *
 * Slack shows this on push notifications and in clients that don't render
 * Block Kit. We keep it deterministic so the same `report` always produces
 * the same fallback.
 */
function fallbackText(report: TriageReport): string {
  return (
    `crashscope: ${report.summary.total} issues in ${report.window} ` +
    `(${report.summary.high} high, ${report.summary.med} med, ${report.summary.low} low)`
  );
}

/**
 * Split a report into one or more Slack payloads, each respecting Slack's
 * {@link SLACK_BLOCK_LIMIT} cap.
 *
 * Chunking strategy:
 *   - The first chunk carries the header / context / divider plus as many
 *     issues as fit under the limit.
 *   - Each continuation chunk opens with a `divider` so visual flow is
 *     preserved across the multi-message thread.
 *   - Issues are *not* split across chunks — a single issue always lives on
 *     one payload — so the chunk that triggers an issue overflow rolls it
 *     into the next chunk.
 *
 * Returns at least one payload even when the report has zero issues (the
 * header-only payload still conveys "we ran, nothing matched").
 */
export function renderSlackPayloadChunks(
  report: TriageReport,
): readonly SlackPayload[] {
  const issueBlockGroups: SlackBlock[][] = report.issues.map((issue) =>
    renderIssueBlocks(issue),
  );

  const payloads: SlackPayload[] = [];
  let currentBlocks: SlackBlock[] = headerBlocks(report);
  let isFirstChunk = true;

  const flush = (): void => {
    if (currentBlocks.length === 0) return;
    payloads.push({ text: fallbackText(report), blocks: currentBlocks });
    currentBlocks = [];
  };

  for (const group of issueBlockGroups) {
    if (currentBlocks.length + group.length > SLACK_BLOCK_LIMIT) {
      // Current chunk is full — flush and start a fresh continuation chunk
      // headed by a divider so the eye picks up the chunk boundary.
      flush();
      isFirstChunk = false;
      currentBlocks = [{ type: "divider" }];
    }
    currentBlocks.push(...group);
  }
  flush();
  // Even when there are no issues we still emit one payload so the receiver
  // sees the header / context block. `isFirstChunk` collapses to that branch
  // because `flush` would have emitted at least the header.
  if (payloads.length === 0) {
    payloads.push({ text: fallbackText(report), blocks: headerBlocks(report) });
  }
  // `isFirstChunk` is referenced only for clarity above; the explicit flag
  // keeps the loop intent self-documenting even though the value isn't
  // returned. Silence TS' unused-variable warning without changing structure.
  void isFirstChunk;
  return payloads;
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
 * Slack's webhook receiver enforces a 50-block cap per payload. Reports with
 * more than ~16 issues exceed that limit, so we chunk into multiple sequential
 * POSTs (see {@link renderSlackPayloadChunks}). Ordering is preserved by
 * awaiting each chunk before sending the next.
 *
 * Per-chunk failures are surfaced inline but do not abort the remaining
 * chunks — the first failure is captured and re-thrown after every chunk has
 * been attempted, so the user gets as much of the report as Slack accepts.
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

  const chunks = renderSlackPayloadChunks(report);
  let firstFailure: AdapterError | null = null;
  let chunkIndex = 0;
  for (const payload of chunks) {
    chunkIndex += 1;
    try {
      await postSlackPayload(url, payload, chunkIndex, chunks.length, fetchImpl);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `Slack chunk ${chunkIndex}/${chunks.length} failed: ${message}\n`,
      );
      if (firstFailure === null) {
        firstFailure =
          err instanceof AdapterError
            ? err
            : new AdapterError(
                "slack",
                `Slack webhook chunk ${chunkIndex}/${chunks.length} failed: ${message}`,
                err instanceof Error ? { cause: err } : undefined,
              );
      }
    }
  }
  if (firstFailure !== null) {
    throw firstFailure;
  }
}

/**
 * Send a single Slack payload, mapping non-2xx responses and transport
 * failures into {@link AdapterError} so the caller can handle them uniformly.
 *
 * Extracted from {@link postSlackReport} so the per-chunk retry / error
 * handling stays linear.
 */
async function postSlackPayload(
  url: string,
  payload: SlackPayload,
  chunkIndex: number,
  chunkTotal: number,
  fetchImpl: typeof fetch,
): Promise<void> {
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
      `Slack webhook request failed (chunk ${chunkIndex}/${chunkTotal}): ${cause.message}`,
      { cause },
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    // Slack returns short text like "invalid_payload" or "no_service" — safe
    // to embed in the error. We deliberately don't echo the webhook URL.
    throw new AdapterError(
      "slack",
      `Slack webhook rejected chunk ${chunkIndex}/${chunkTotal} (HTTP ${response.status}): ${body.slice(0, 200)}`,
    );
  }
}
