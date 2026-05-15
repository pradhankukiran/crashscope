import { z } from "zod";

/**
 * Session/analytics providers crashscope can ingest from.
 */
export const sessionProviderSchema = z.enum(["posthog", "logrocket"]);
export type SessionProvider = z.infer<typeof sessionProviderSchema>;

/**
 * Normalized event type emitted during a session.
 *
 * Providers expose richer taxonomies; we fold them into this finite set so the
 * triage LLM can reason without provider-specific knowledge. Anything else
 * lands under "other" with the raw payload preserved in `properties`.
 */
export const normalizedEventTypeSchema = z.enum([
  "click",
  "input",
  "navigation",
  "error",
  "rage_click",
  "dead_click",
  "scroll",
  "other",
]);
export type NormalizedEventType = z.infer<typeof normalizedEventTypeSchema>;

export const normalizedEventSchema = z.object({
  timestamp: z.string().datetime({ offset: true }),
  type: normalizedEventTypeSchema,
  target: z.string().nullable(),
  properties: z.record(z.string(), z.unknown()),
});
export type NormalizedEvent = z.infer<typeof normalizedEventSchema>;

export const pageViewSchema = z.object({
  url: z.string(),
  timestamp: z.string().datetime({ offset: true }),
});
export type PageView = z.infer<typeof pageViewSchema>;

/**
 * Provider-agnostic representation of a single user session/replay window.
 *
 * Adapters resolve a session in a time window near an error and project it
 * into this shape. `replayUrl` is optional because not every provider exposes
 * a deep link.
 */
export const normalizedSessionSchema = z.object({
  id: z.string().min(1),
  provider: sessionProviderSchema,
  userId: z.string(),
  startedAt: z.string().datetime({ offset: true }),
  durationMs: z.number().int().nonnegative(),
  replayUrl: z.string().url().nullable(),
  events: z.array(normalizedEventSchema),
  pageViews: z.array(pageViewSchema),
  raw: z.unknown(),
});
export type NormalizedSession = z.infer<typeof normalizedSessionSchema>;
