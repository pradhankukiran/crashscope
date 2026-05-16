/**
 * Redact secret-looking values from arbitrary text.
 *
 * Use case: debug-log dumps. The error/session adapters echo full URLs and
 * occasionally token-bearing request lines into their error messages; we
 * pass those through this filter before writing anything to disk or stderr.
 *
 * The implementation is intentionally conservative — we err on the side of
 * over-masking to avoid leaking credentials in support tickets. False
 * positives just produce a harmless `…` in the middle of an unrelated string.
 */

/**
 * Patterns that almost certainly indicate a credential.
 *
 * Order matters: earlier entries are tried first, so the more specific
 * provider-prefixed patterns sit *above* the generic `sk-…` / Bearer rules
 * to avoid double-mangling a token (e.g. "sntrys_…" being shortened twice).
 *
 * Each entry replaces with `MASK_REPLACEMENT` and preserves enough context for
 * a human to recognise the surrounding format ("Bearer sk-…1234") so a debug
 * log remains diagnosable.
 */
const PATTERNS: ReadonlyArray<{ re: RegExp; render: (m: RegExpExecArray) => string }> = [
  // Sentry: both legacy `sntry_` and the current `sntrys_` prefix.
  {
    re: /\bsntrys?_[A-Za-z0-9_-]{20,}\b/g,
    render: (m) => maskPreservingTail(m[0]),
  },
  // PostHog personal API keys (phx_…) and project keys (phc_…).
  {
    re: /\bph[xc]_[A-Za-z0-9_-]{20,}\b/g,
    render: (m) => maskPreservingTail(m[0]),
  },
  // Honeybadger personal access tokens.
  {
    re: /\bhbp_[A-Za-z0-9_-]{20,}\b/g,
    render: (m) => maskPreservingTail(m[0]),
  },
  // Slack bot / user tokens.
  {
    re: /\bxox[bp]-[A-Za-z0-9_-]+\b/g,
    render: (m) => maskPreservingTail(m[0]),
  },
  // Anthropic-style API keys: sk-ant-* (kept distinct from the generic rule
  // below so the prefix stays visible after masking).
  {
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    render: (m) => maskPreservingTail(m[0]),
  },
  // Generic `sk-…` keys (OpenAI-style, any provider using that prefix).
  {
    re: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    render: (m) => maskPreservingTail(m[0]),
  },
  // Authorization / Bearer / token headers — case-insensitive on the keyword.
  // Captures the value so a recognisable tail survives in the output.
  {
    re: /\b(authorization|bearer|token|api[-_]?key)\s*[:=]\s*["']?([A-Za-z0-9._\-]{8,})["']?/gi,
    render: (m) => `${m[1]}=${maskPreservingTail(m[2] ?? "")}`,
  },
  // Standalone Bearer header value (e.g. "Bearer abc.def.ghi").
  {
    re: /\b([Bb]earer)\s+([A-Za-z0-9._\-]{8,})\b/g,
    render: (m) => `${m[1]} ${maskPreservingTail(m[2] ?? "")}`,
  },
  // Slack incoming-webhook URL secrets.
  {
    re: /https:\/\/hooks\.slack\.com\/services\/[A-Z0-9\/]+/g,
    render: () => "https://hooks.slack.com/services/<REDACTED>",
  },
];

/**
 * Mask a token while keeping its first two and last four chars so logs remain
 * triagable. "sk-ant-abc...wxyz" → "sk…wxyz".
 */
export function maskPreservingTail(token: string): string {
  if (token.length <= 8) return "…";
  return token.slice(0, 2) + "…" + token.slice(-4);
}

/**
 * Apply every redaction pattern to `text`. Returns the cleaned string.
 *
 * Stable under repeated application — running `redact(redact(x))` is a no-op.
 */
export function redact(text: string): string {
  let out = text;
  for (const { re, render } of PATTERNS) {
    out = out.replace(re, (...args) => {
      // String.replace passes the match array as positional arguments; we
      // reconstruct the RegExpExecArray-shaped object for `render`.
      const offset = args[args.length - 2] as number;
      const input = args[args.length - 1] as string;
      const groups = args.slice(0, -2) as string[];
      const match = Object.assign(groups.slice(), {
        index: offset,
        input,
      }) as unknown as RegExpExecArray;
      return render(match);
    });
  }
  return out;
}

/**
 * Mask an arbitrary value's surface form for display.
 *
 * `null`/`undefined` collapse to a literal placeholder so the field is still
 * visible in the rendered config; everything else is JSON-serialised and run
 * through {@link redact}.
 */
export function redactValue(value: unknown): string {
  if (value === null || value === undefined) return "<none>";
  if (typeof value === "string") return maskPreservingTail(value);
  return redact(JSON.stringify(value));
}
