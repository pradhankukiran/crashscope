import type { NormalizedError } from "../types/error.js";
import type { NormalizedSession } from "../types/session.js";

/** Max stack frames included in the prompt before truncation. */
const STACK_MAX_LINES = 30;

/** Max session events (newest-first) inlined into the prompt. */
const SESSION_EVENT_LIMIT = 25;

/** Max page views inlined into the prompt. */
const PAGE_VIEW_LIMIT = 10;

/** Max characters retained per stack line / event description. */
const LINE_MAX_CHARS = 240;

/** Max number of breadcrumbs included. */
const BREADCRUMB_LIMIT = 15;

/** Max tags rendered before truncation. */
const TAG_LIMIT = 20;

/**
 * Truncate a single line of context to keep prompts compact and predictable.
 *
 * Uses a visible ellipsis-style marker rather than the unicode ellipsis so the
 * model never confuses our truncation with content the user typed.
 */
function truncateLine(line: string, max: number = LINE_MAX_CHARS): string {
  if (line.length <= max) return line;
  return `${line.slice(0, max - 5)} ...[truncated]`;
}

/**
 * Format a stack trace to at most {@link STACK_MAX_LINES} lines.
 */
function formatStack(stack: string | null): string {
  if (!stack) return "(no stack trace available)";
  const lines = stack.split(/\r?\n/);
  const head = lines.slice(0, STACK_MAX_LINES).map((l) => truncateLine(l));
  const omitted = lines.length - head.length;
  if (omitted > 0) {
    head.push(`...[${omitted} more frame(s) omitted]`);
  }
  return head.join("\n");
}

/**
 * Render breadcrumb list compactly: timestamp · category · message.
 */
function formatBreadcrumbs(error: NormalizedError): string {
  if (error.breadcrumbs.length === 0) return "(none)";
  const recent = error.breadcrumbs.slice(-BREADCRUMB_LIMIT);
  const omitted = error.breadcrumbs.length - recent.length;
  const lines = recent.map(
    (b) => `- ${b.timestamp} [${b.category}] ${truncateLine(b.message)}`,
  );
  if (omitted > 0) {
    lines.unshift(`(...${omitted} earlier breadcrumb(s) omitted)`);
  }
  return lines.join("\n");
}

/**
 * Format the tag map as `k=v` pairs with truncation.
 */
function formatTags(tags: Record<string, string>): string {
  const entries = Object.entries(tags);
  if (entries.length === 0) return "(none)";
  const head = entries.slice(0, TAG_LIMIT);
  const out = head.map(([k, v]) => `${k}=${truncateLine(v, 80)}`).join(", ");
  const omitted = entries.length - head.length;
  return omitted > 0 ? `${out} (+${omitted} more)` : out;
}

/**
 * Render page views, oldest-first, limited to {@link PAGE_VIEW_LIMIT}.
 */
function formatPageViews(session: NormalizedSession): string {
  if (session.pageViews.length === 0) return "(no page views)";
  const head = session.pageViews.slice(0, PAGE_VIEW_LIMIT);
  const omitted = session.pageViews.length - head.length;
  const lines = head.map((p) => `- ${p.timestamp} ${truncateLine(p.url, 120)}`);
  if (omitted > 0) {
    lines.push(`(...${omitted} more page view(s) omitted)`);
  }
  return lines.join("\n");
}

/**
 * Render the most informative slice of session events.
 *
 * Heuristic: prefer the tail (events closest to the error) because that's where
 * the trigger sequence lives. We render `[type] target — properties.summary`
 * one per line.
 */
function formatEvents(session: NormalizedSession): string {
  if (session.events.length === 0) return "(no events)";
  const tail = session.events.slice(-SESSION_EVENT_LIMIT);
  const omitted = session.events.length - tail.length;
  const lines = tail.map((e) => {
    const target = e.target ? ` ${truncateLine(e.target, 80)}` : "";
    return `- ${e.timestamp} [${e.type}]${target}`;
  });
  if (omitted > 0) {
    lines.unshift(`(...${omitted} earlier event(s) omitted)`);
  }
  return lines.join("\n");
}

/**
 * Build the user-side prompt sent to Claude for a single error.
 *
 * The shape:
 * - A short directive describing the goal and required tool call.
 * - An `<error>` block with normalized error fields + truncated stack + tags.
 * - An optional `<session>` block with timeline (page views + events).
 * - A trailing instruction reminding the model that the only valid output is a
 *   single call to the `emit_triage_finding` tool.
 *
 * Keep this function deterministic and side-effect-free; the investigation
 * loop relies on stable prompts for replay/debugging.
 */
export function buildInvestigationPrompt(
  error: NormalizedError,
  session: NormalizedSession | null,
): string {
  const sessionBlock = session
    ? [
        "<session>",
        `id: ${session.id}`,
        `provider: ${session.provider}`,
        `userId: ${session.userId}`,
        `startedAt: ${session.startedAt}`,
        `durationMs: ${session.durationMs}`,
        `replayUrl: ${session.replayUrl ?? "(none)"}`,
        "",
        "pageViews:",
        formatPageViews(session),
        "",
        "events:",
        formatEvents(session),
        "</session>",
      ].join("\n")
    : "<session>(no overlapping session available for this user/error)</session>";

  return [
    "You are an experienced web engineer triaging a production error. " +
      "Examine the normalized error and (when present) the user session that " +
      "led up to it, then produce a single, high-signal hypothesis.",
    "",
    "<error>",
    `id: ${error.id}`,
    `provider: ${error.provider}`,
    `severity: ${error.severity}`,
    `title: ${truncateLine(error.title)}`,
    `type: ${truncateLine(error.type, 120)}`,
    `message: ${truncateLine(error.message)}`,
    `environment: ${error.environment ?? "(unknown)"}`,
    `releaseVersion: ${error.releaseVersion ?? "(unknown)"}`,
    `affectedUsers: ${error.affectedUsers}`,
    `eventCount: ${error.eventCount}`,
    `firstSeen: ${error.firstSeen}`,
    `lastSeen: ${error.lastSeen}`,
    `tags: ${formatTags(error.tags)}`,
    "",
    "stack (truncated):",
    formatStack(error.stack),
    "",
    "breadcrumbs:",
    formatBreadcrumbs(error),
    "</error>",
    "",
    sessionBlock,
    "",
    "Return your analysis by calling the `emit_triage_finding` tool exactly once. " +
      "Do not narrate; do not produce additional prose after the tool call. " +
      "Fields:",
    "- hypothesis: one tight sentence stating what likely went wrong (<= 280 chars).",
    "- rootCauseGuess: the suspected root cause in code/config terms (<= 200 chars).",
    "- suggestedFiles: up to 5 likely-relevant file paths inferred from the stack and message.",
    "- userJourney: 1-2 sentences summarizing what the user did before the error (<= 300 chars). If no session is available, say so plainly.",
    "- confidence: 'high' | 'med' | 'low' — be honest; 'low' is correct when evidence is thin.",
  ].join("\n");
}
