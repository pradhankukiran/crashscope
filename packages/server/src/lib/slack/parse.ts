/**
 * Parse the `text` field of `/triage` into a structured options bag.
 *
 * Supported shapes (whitespace-separated, position-insensitive):
 *   `/triage`                            → defaults
 *   `/triage 6h`                         → since=6h
 *   `/triage 7d limit=50`                → since=7d, limit=50
 *   `/triage 24h severity=error,fatal`   → severity filter applied
 *
 * Unknown tokens are ignored rather than rejected so a typo doesn't block the
 * user from getting *some* report — the slash command is interactive and we
 * prefer "did something sensible" over "rejected outright".
 */
import type { Severity } from "@pradhankukiran/crashscope-core";
import { isSinceKeyword, type SinceKeyword } from "../triage.js";

/** Parsed `/triage` command options. */
export interface ParsedTriageCommand {
  since: SinceKeyword;
  limit: number;
  severities?: Severity[];
}

const ALLOWED_SEVERITIES: readonly Severity[] = [
  "fatal",
  "error",
  "warning",
  "info",
] as const;

function parseLimit(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 100) return null;
  return Math.floor(n);
}

function parseSeverityList(raw: string): Severity[] | null {
  const tokens = raw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  const seen = new Set<Severity>();
  for (const t of tokens) {
    if (!(ALLOWED_SEVERITIES as readonly string[]).includes(t)) return null;
    seen.add(t as Severity);
  }
  return Array.from(seen);
}

/**
 * Parse the raw slash-command text. Returns the canonicalized options
 * structure with safe defaults.
 */
export function parseTriageCommand(text: string): ParsedTriageCommand {
  const tokens = text.trim().split(/\s+/).filter((t) => t.length > 0);
  let since: SinceKeyword = "24h";
  let limit = 25;
  let severities: Severity[] | undefined;

  for (const tok of tokens) {
    // bare window keyword
    if (isSinceKeyword(tok)) {
      since = tok;
      continue;
    }
    const eq = tok.indexOf("=");
    if (eq < 0) continue;
    const key = tok.slice(0, eq).trim().toLowerCase();
    const value = tok.slice(eq + 1).trim();
    if (!value) continue;
    if (key === "since" && isSinceKeyword(value)) since = value;
    else if (key === "limit") {
      const parsed = parseLimit(value);
      if (parsed !== null) limit = parsed;
    } else if (key === "severity" || key === "severities") {
      const parsed = parseSeverityList(value);
      if (parsed) severities = parsed;
    }
  }

  return severities ? { since, limit, severities } : { since, limit };
}
