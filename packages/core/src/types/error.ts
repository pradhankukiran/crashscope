import { z } from "zod";

/**
 * Error tracker providers crashscope can ingest from.
 */
export const errorProviderSchema = z.enum([
  "sentry",
  "rollbar",
  "bugsnag",
  "honeybadger",
]);
export type ErrorProvider = z.infer<typeof errorProviderSchema>;

/**
 * Severity levels normalized across providers.
 *
 * Mapping notes:
 * - Sentry levels: fatal, error, warning, info, debug → debug folded into info.
 * - Rollbar: critical → fatal, error → error, warning → warning, info/debug → info.
 * - Bugsnag severity: error → error, warning → warning, info → info; "fatal"
 *   is inferred from unhandled flag.
 */
export const severitySchema = z.enum(["fatal", "error", "warning", "info"]);
export type Severity = z.infer<typeof severitySchema>;

/**
 * A single breadcrumb leading up to an error (UI action, navigation, log line).
 */
export const breadcrumbSchema = z.object({
  timestamp: z.string().datetime({ offset: true }),
  category: z.string(),
  message: z.string(),
});
export type Breadcrumb = z.infer<typeof breadcrumbSchema>;

/**
 * Optional environmental fingerprint of an error.
 *
 * Each field is independently optional so partial-info adapters can populate
 * what they know without forcing the others. All values are short strings the
 * triage prompt can include verbatim.
 */
export const errorContextSchema = z.object({
  runtime: z.string().optional(),
  platform: z.string().optional(),
  fingerprint: z.string().optional(),
});
export type ErrorContext = z.infer<typeof errorContextSchema>;

/**
 * Provider-agnostic representation of an error/issue.
 *
 * Adapters are responsible for translating their native payloads into this
 * shape. `raw` holds the untouched original for advanced consumers.
 *
 * `context` is optional — adapters that don't expose runtime/platform/fingerprint
 * data simply omit it. Adding fields to it is non-breaking: all sub-fields are
 * optional so existing consumers keep compiling.
 */
export const normalizedErrorSchema = z.object({
  id: z.string().min(1),
  provider: errorProviderSchema,
  title: z.string(),
  message: z.string(),
  type: z.string(),
  stack: z.string().nullable(),
  severity: severitySchema,
  environment: z.string().nullable(),
  releaseVersion: z.string().nullable(),
  affectedUsers: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  firstSeen: z.string().datetime({ offset: true }),
  lastSeen: z.string().datetime({ offset: true }),
  sourceUrl: z.string().url(),
  sampleUserIds: z.array(z.string()),
  breadcrumbs: z.array(breadcrumbSchema),
  tags: z.record(z.string(), z.string()),
  context: errorContextSchema.optional(),
  raw: z.unknown(),
});
export type NormalizedError = z.infer<typeof normalizedErrorSchema>;
