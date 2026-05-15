/**
 * Recognised duration suffixes. We accept only these to keep parsing tight —
 * "3 minutes" or "2 weeks" don't appear in any CLI example and would
 * complicate the inverse (rendering a "last 24h" window string).
 */
type DurationUnit = "h" | "d";

/**
 * Convert a `--since` flag value (e.g. "1h", "24h", "7d") into an absolute
 * lower bound, anchored to `now`.
 *
 * Returns both:
 * - `date`: the absolute lower bound — adapters consume this directly.
 * - `windowLabel`: the same shape rendered back as "last 24h" / "last 7d" for
 *   the triage report `window` field.
 *
 * Throws `RangeError` on malformed input so callers can map it to the CLI's
 * "user error" exit code (1).
 */
export function parseSince(
  raw: string,
  now: Date = new Date(),
): { date: Date; windowLabel: string } {
  const trimmed = raw.trim().toLowerCase();
  const match = /^(\d+)([hd])$/.exec(trimmed);
  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new RangeError(
      `Invalid --since value "${raw}". Use forms like "1h", "24h", "7d", or "30d".`,
    );
  }
  const amount = Number.parseInt(match[1], 10);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new RangeError(
      `Invalid --since value "${raw}". The numeric part must be a positive integer.`,
    );
  }
  const unit = match[2] as DurationUnit;
  const ms = unit === "h" ? amount * 3_600_000 : amount * 86_400_000;
  const date = new Date(now.getTime() - ms);
  return { date, windowLabel: `last ${amount}${unit}` };
}
