import type { NormalizedError, Severity } from "./error.js";
import type { NormalizedSession } from "./session.js";

/**
 * Options for {@link ErrorAdapter.fetchRecent}.
 */
export interface FetchRecentOptions {
  /** Lower bound on `lastSeen`. */
  since: Date;
  /** Maximum number of issues to return. */
  limit: number;
  /** If provided, restrict to these severities. */
  severities?: Severity[];
}

/**
 * Options for {@link SessionAdapter.fetchForUser}.
 */
export interface FetchForUserOptions {
  userId: string;
  /** Anchor timestamp (typically the error's `lastSeen`). */
  around: Date;
  /**
   * Half-window in milliseconds. Adapter should search for a session
   * intersecting `[around - windowMs, around + windowMs]`.
   */
  windowMs?: number;
}

/**
 * Adapter contract for an error tracker provider.
 *
 * Implementations live in `@crashscope/adapter-<provider>` packages. Each
 * adapter is responsible for authentication, pagination, and translating the
 * provider's native payload into {@link NormalizedError}.
 */
export interface ErrorAdapter {
  /** Stable identifier for this adapter, e.g. "sentry". */
  readonly name: string;

  /**
   * Return recent issues matching the filter. Implementations should respect
   * `limit` server-side when possible; otherwise truncate before returning.
   */
  fetchRecent(opts: FetchRecentOptions): Promise<NormalizedError[]>;

  /**
   * Hydrate a single issue by its provider-internal id, including stack and
   * breadcrumbs. Throw {@link AdapterError} if the issue cannot be retrieved.
   */
  fetchDetail(id: string): Promise<NormalizedError>;
}

/**
 * Adapter contract for a session/replay provider.
 *
 * Implementations live in `@crashscope/adapter-<provider>` packages and
 * resolve a session that overlaps a given error timestamp for a given user.
 */
export interface SessionAdapter {
  /** Stable identifier for this adapter, e.g. "posthog". */
  readonly name: string;

  /**
   * Find a session for `userId` near `around`. Returns `null` if no overlapping
   * session is found — callers should treat that as "no replay available"
   * rather than an error condition.
   */
  fetchForUser(opts: FetchForUserOptions): Promise<NormalizedSession | null>;

  /**
   * Build a deep link into the provider's replay UI. Returns `null` if the
   * provider does not expose replays (or this session isn't replayable).
   */
  replayUrl(sessionId: string): string | null;
}
