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
 * Global cap on the rendered prompt length. If the assembled prompt exceeds
 * this, the middle is truncated with a visible marker so the prompt header
 * (instructions) and tail (final instructions) are both preserved.
 *
 * Exported so callers can size their inputs or replicate the same cap upstream.
 */
export const MAX_PROMPT_CHARS = 40_000;

/**
 * Marker substituted into truncated prompts. Distinctive so post-hoc log
 * scrapes can detect the case ("prompt exceeded 40 KB").
 */
const PROMPT_TRUNCATED_MARKER =
  "\n...[truncated: prompt exceeded 40 KB]...\n";

/**
 * Best-effort prompt-injection hardening for user-controlled fields.
 *
 * NOT a security guarantee — a sufficiently determined adversarial upstream
 * (e.g. a compromised error tracker) can still craft inputs that confuse the
 * model. This helper raises the cost of trivial injection by:
 *
 * - Neutralising the structural XML-ish tags we use as delimiters
 *   (`<error>`, `</error>`, `<session>`, `</session>`, `<system>`,
 *   `<instructions>`) by replacing them with HTML entity equivalents so they
 *   no longer parse as our own markup when the model reads them.
 * - Entity-encoding any other content that looks like an XML/HTML tag.
 * - Stripping ASCII control characters that could be used to smuggle
 *   formatting or invisible directives.
 * - Capping the resulting string to a per-field max so a single hostile field
 *   cannot blow out the global prompt budget.
 */
export function sanitizeForPrompt(s: string, max: number = LINE_MAX_CHARS): string {
  if (typeof s !== "string" || s.length === 0) return s;
  // 1. Strip ASCII control characters (preserve \t, \n, \r → 0x09, 0x0A, 0x0D).
  let out = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  // 2. Neutralise our own structural delimiters + common reinjection vectors.
  //    Match opening and closing variants, case-insensitive.
  const STRUCTURAL_TAGS = [
    "error",
    "session",
    "system",
    "instructions",
  ] as const;
  for (const tag of STRUCTURAL_TAGS) {
    const open = new RegExp(`<${tag}\\b[^>]*>`, "gi");
    const close = new RegExp(`</${tag}\\s*>`, "gi");
    out = out.replace(open, (m) => `&lt;${m.slice(1, -1)}&gt;`);
    out = out.replace(close, (m) => `&lt;${m.slice(1, -1)}&gt;`);
  }
  // 3. Entity-encode any remaining XML/HTML-style tags so injected
  //    pseudo-markup loses its delimiters.
  out = out.replace(/<\/?[a-zA-Z][^>]*>/g, (m) => `&lt;${m.slice(1, -1)}&gt;`);
  // 4. Per-field length cap.
  if (out.length > max) {
    out = `${out.slice(0, max - 5)} ...[truncated]`;
  }
  return out;
}

/**
 * Truncate a single line of context to keep prompts compact and predictable.
 *
 * Uses a visible ellipsis-style marker rather than the unicode ellipsis so the
 * model never confuses our truncation with content the user typed.
 *
 * NOTE: this is the legacy length-only helper. For user-controlled strings,
 * prefer {@link sanitizeForPrompt} which also neutralises injected markup.
 */
function truncateLine(line: string, max: number = LINE_MAX_CHARS): string {
  if (line.length <= max) return line;
  return `${line.slice(0, max - 5)} ...[truncated]`;
}

/**
 * Format a stack trace to at most {@link STACK_MAX_LINES} lines. Stack traces
 * are user-controlled too — they originate in the error tracker payload — so
 * each line goes through {@link sanitizeForPrompt}.
 */
function formatStack(stack: string | null): string {
  if (!stack) return "(no stack trace available)";
  const lines = stack.split(/\r?\n/);
  const head = lines.slice(0, STACK_MAX_LINES).map((l) => sanitizeForPrompt(l));
  const omitted = lines.length - head.length;
  if (omitted > 0) {
    head.push(`...[${omitted} more frame(s) omitted]`);
  }
  return head.join("\n");
}

/**
 * Render breadcrumb list compactly: timestamp · category · message.
 *
 * Breadcrumb category + message are user-controlled, so both get sanitized.
 */
function formatBreadcrumbs(error: NormalizedError): string {
  if (error.breadcrumbs.length === 0) return "(none)";
  const recent = error.breadcrumbs.slice(-BREADCRUMB_LIMIT);
  const omitted = error.breadcrumbs.length - recent.length;
  const lines = recent.map(
    (b) =>
      `- ${b.timestamp} [${sanitizeForPrompt(b.category, 64)}] ${sanitizeForPrompt(b.message)}`,
  );
  if (omitted > 0) {
    lines.unshift(`(...${omitted} earlier breadcrumb(s) omitted)`);
  }
  return lines.join("\n");
}

/**
 * Format the tag map as `k=v` pairs with truncation.
 *
 * Tag keys and values are both user-controlled and get sanitized.
 */
function formatTags(tags: Record<string, string>): string {
  const entries = Object.entries(tags);
  if (entries.length === 0) return "(none)";
  const head = entries.slice(0, TAG_LIMIT);
  const out = head
    .map(
      ([k, v]) =>
        `${sanitizeForPrompt(k, 64)}=${sanitizeForPrompt(v, 80)}`,
    )
    .join(", ");
  const omitted = entries.length - head.length;
  return omitted > 0 ? `${out} (+${omitted} more)` : out;
}

/**
 * Render page views, oldest-first, limited to {@link PAGE_VIEW_LIMIT}.
 *
 * URLs come from the session adapter and may contain user data (query string,
 * path segments), so they get sanitized too.
 */
function formatPageViews(session: NormalizedSession): string {
  if (session.pageViews.length === 0) return "(no page views)";
  const head = session.pageViews.slice(0, PAGE_VIEW_LIMIT);
  const omitted = session.pageViews.length - head.length;
  const lines = head.map(
    (p) => `- ${p.timestamp} ${sanitizeForPrompt(p.url, 120)}`,
  );
  if (omitted > 0) {
    lines.push(`(...${omitted} more page view(s) omitted)`);
  }
  return lines.join("\n");
}

/**
 * Render the most informative slice of session events.
 *
 * Heuristic: prefer the tail (events closest to the error) because that's where
 * the trigger sequence lives. We render `[type] target` one per line. The
 * target field is user-controlled (typically a CSS selector or DOM label) and
 * goes through {@link sanitizeForPrompt}.
 */
function formatEvents(session: NormalizedSession): string {
  if (session.events.length === 0) return "(no events)";
  const tail = session.events.slice(-SESSION_EVENT_LIMIT);
  const omitted = session.events.length - tail.length;
  const lines = tail.map((e) => {
    const target = e.target ? ` ${sanitizeForPrompt(e.target, 80)}` : "";
    return `- ${e.timestamp} [${e.type}]${target}`;
  });
  if (omitted > 0) {
    lines.unshift(`(...${omitted} earlier event(s) omitted)`);
  }
  return lines.join("\n");
}

/**
 * Sanitize a nullable label field — adapters surface plenty of these.
 */
function sanLabel(value: string | null, max: number = LINE_MAX_CHARS): string {
  if (value === null) return "(unknown)";
  return sanitizeForPrompt(value, max);
}

/**
 * Apply the global prompt-length cap by truncating the middle. We keep the
 * head (instructions + most of the error block) and the tail (closing
 * instructions) intact since the model leans heavily on both for output shape.
 */
function applyGlobalCap(prompt: string): string {
  if (prompt.length <= MAX_PROMPT_CHARS) return prompt;
  // Log marker so callers can detect oversized prompts in stderr.
  console.warn(
    `[crashscope/agent] prompt exceeded MAX_PROMPT_CHARS (${MAX_PROMPT_CHARS}); truncating middle`,
  );
  const keep = MAX_PROMPT_CHARS - PROMPT_TRUNCATED_MARKER.length;
  const headLen = Math.floor(keep * 0.6);
  const tailLen = keep - headLen;
  return (
    prompt.slice(0, headLen) +
    PROMPT_TRUNCATED_MARKER +
    prompt.slice(prompt.length - tailLen)
  );
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
 * Every interpolated user-controlled field is run through
 * {@link sanitizeForPrompt} to blunt trivial prompt-injection attempts (see
 * that helper's docstring; this is best-effort, not a guarantee). The final
 * assembled prompt is capped at {@link MAX_PROMPT_CHARS}.
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
        `id: ${sanitizeForPrompt(session.id, 128)}`,
        `provider: ${session.provider}`,
        `userId: ${sanitizeForPrompt(session.userId, 128)}`,
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

  const contextBlock = error.context
    ? [
        `context.runtime: ${
          error.context.runtime
            ? sanitizeForPrompt(error.context.runtime, 80)
            : "(unknown)"
        }`,
        `context.platform: ${
          error.context.platform
            ? sanitizeForPrompt(error.context.platform, 80)
            : "(unknown)"
        }`,
        `context.fingerprint: ${
          error.context.fingerprint
            ? sanitizeForPrompt(error.context.fingerprint, 128)
            : "(unknown)"
        }`,
      ]
    : [];

  const prompt = [
    "You are an experienced web engineer triaging a production error. " +
      "Examine the normalized error and (when present) the user session that " +
      "led up to it, then produce a single, high-signal hypothesis.",
    "",
    "<error>",
    `id: ${sanitizeForPrompt(error.id, 128)}`,
    `provider: ${error.provider}`,
    `severity: ${error.severity}`,
    `title: ${sanitizeForPrompt(error.title)}`,
    `type: ${sanitizeForPrompt(error.type, 120)}`,
    `message: ${sanitizeForPrompt(error.message)}`,
    `environment: ${sanLabel(error.environment, 80)}`,
    `releaseVersion: ${sanLabel(error.releaseVersion, 80)}`,
    `affectedUsers: ${error.affectedUsers}`,
    `eventCount: ${error.eventCount}`,
    `firstSeen: ${error.firstSeen}`,
    `lastSeen: ${error.lastSeen}`,
    `tags: ${formatTags(error.tags)}`,
    ...contextBlock,
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

  return applyGlobalCap(prompt);
}
