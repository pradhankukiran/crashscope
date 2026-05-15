import { z } from "zod";
import { errorProviderSchema, severitySchema } from "./error.js";
import { sessionProviderSchema } from "./session.js";

/**
 * Model confidence in a triage hypothesis.
 *
 * - `high`: strong signal (reproducible from session, clear stack root).
 * - `med`: plausible inference from partial evidence.
 * - `low`: best guess; the report surfaces this as such.
 */
export const confidenceSchema = z.enum(["high", "med", "low"]);
export type Confidence = z.infer<typeof confidenceSchema>;

/**
 * A single triaged issue: an error joined with the LLM's analysis and (when
 * available) the supporting session.
 */
export const triageIssueSchema = z.object({
  errorId: z.string().min(1),
  severity: severitySchema,
  provider: z.string(),
  title: z.string(),
  affectedUsers: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  firstSeen: z.string().datetime({ offset: true }),
  lastSeen: z.string().datetime({ offset: true }),
  environment: z.string().nullable(),
  releaseVersion: z.string().nullable(),
  sourceUrl: z.string().url(),
  replayUrl: z.string().url().nullable(),
  sessionId: z.string().nullable(),
  hypothesis: z.string(),
  rootCauseGuess: z.string(),
  suggestedFiles: z.array(z.string()),
  userJourney: z.string(),
  confidence: confidenceSchema,
});
export type TriageIssue = z.infer<typeof triageIssueSchema>;

export const triageSummarySchema = z.object({
  high: z.number().int().nonnegative(),
  med: z.number().int().nonnegative(),
  low: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type TriageSummary = z.infer<typeof triageSummarySchema>;

export const triageMetaSchema = z.object({
  errorProvider: errorProviderSchema,
  sessionProvider: sessionProviderSchema,
  durationMs: z.number().int().nonnegative(),
});
export type TriageMeta = z.infer<typeof triageMetaSchema>;

/**
 * The top-level triage report — the artifact crashscope emits to terminal,
 * Slack, or JSON.
 *
 * `window` is a human-readable description of the time slice considered
 * (e.g. "last 24h"). Machine-readable bounds live in adapter calls, not here.
 */
export const triageReportSchema = z.object({
  generatedAt: z.string().datetime({ offset: true }),
  window: z.string(),
  summary: triageSummarySchema,
  issues: z.array(triageIssueSchema),
  meta: triageMetaSchema,
});
export type TriageReport = z.infer<typeof triageReportSchema>;
