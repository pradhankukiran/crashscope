/**
 * Best-effort credential redactor for log lines.
 *
 * Adapter and SDK errors routinely include the request URL, sometimes the
 * request headers, and not infrequently the offending token they were sent
 * with — the body of an upstream 401 from Anthropic or PostHog often echoes
 * the prefix of the key it didn't like. Sending those straight into
 * `console.error` leaks secrets to whatever centralised logging lives
 * downstream (CloudWatch, Logflare, Sentry's own server-side capture, etc.).
 *
 * This module scrubs known token shapes from arbitrary error objects before
 * they hit the console. It is *not* a substitute for never logging
 * credentials in the first place — but it's the last line of defence for
 * code paths we don't fully control (third-party SDKs throwing through us).
 *
 * Patterns intentionally err on the side of false positives: a few extra
 * `[REDACTED]` substrings in logs is fine, a leaked key is not.
 */

/**
 * One pattern per known credential shape. Order doesn't matter — they're all
 * applied in sequence and they don't overlap.
 *
 * Each pattern matches a leading prefix + a "token-y" body of base64-ish or
 * hex characters. The minimum-length tail is set to avoid e.g. eating the
 * word "Bearer" on its own when it shows up in a sentence.
 */
const PATTERNS: ReadonlyArray<RegExp> = [
  // Sentry user / org tokens (sntrys_...) — Sentry's modern token format.
  /sntrys_[A-Za-z0-9_=+/\-]{20,}/g,
  // PostHog personal API keys.
  /phx_[A-Za-z0-9_\-]{20,}/g,
  // PostHog project / public keys.
  /phc_[A-Za-z0-9_\-]{20,}/g,
  // Honeybadger personal access tokens.
  /hbp_[A-Za-z0-9_\-]{20,}/g,
  // Slack bot tokens.
  /xoxb-[A-Za-z0-9\-]{10,}/g,
  // Slack user tokens (covered defensively — we don't ingest these today).
  /xoxp-[A-Za-z0-9\-]{10,}/g,
  // Generic `sk-...` keys: Anthropic (`sk-ant-`), OpenAI (`sk-`), etc.
  /sk-[A-Za-z0-9_\-]{20,}/g,
  // `Authorization: Bearer <token>` lines, captured loosely so we catch them
  // whether they were emitted by `node-fetch`, undici, or string-built error
  // messages.
  /Bearer\s+[A-Za-z0-9_\-.=+/]{10,}/gi,
];

/** Replace every match of every pattern with a fixed sentinel. */
function scrub(input: string): string {
  let out = input;
  for (const re of PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

/**
 * Build a redacted view of an arbitrary value suitable for `console.error`.
 *
 * The strategy depends on the value type:
 *  - `string`: scrubbed directly.
 *  - `Error`: a *new* Error of the same name with redacted `message` /
 *    `stack`. We don't mutate the original because it may still be thrown
 *    further up and we don't want to lose the original message for callers
 *    who keep their own (in-memory, not console) sink.
 *  - Anything else: serialised through `JSON.stringify` (handling cycles via
 *    a replacer) and scrubbed.
 *
 * The function never throws — failure to redact falls back to a generic
 * sentinel rather than letting `console.error` see the raw value.
 */
export function redactError(err: unknown): unknown {
  try {
    if (typeof err === "string") return scrub(err);
    if (err instanceof Error) {
      const wrapped = new Error(scrub(err.message));
      wrapped.name = err.name;
      if (err.stack) wrapped.stack = scrub(err.stack);
      // Preserve `cause` if it's an Error, recursing once.
      const cause = (err as { cause?: unknown }).cause;
      if (cause !== undefined) {
        (wrapped as { cause?: unknown }).cause = redactError(cause);
      }
      return wrapped;
    }
    if (err === null || err === undefined) return err;
    const serialised = safeStringify(err);
    return scrub(serialised);
  } catch {
    return "[REDACTION_FAILED]";
  }
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return "[Circular]";
      seen.add(v);
    }
    return v;
  });
}

/**
 * Convenience wrapper: scrub a plain string. Useful for emitting log lines
 * that interpolate user-supplied values (URLs, messages) without a wrapping
 * error object.
 */
export function redactString(input: string): string {
  return scrub(input);
}
