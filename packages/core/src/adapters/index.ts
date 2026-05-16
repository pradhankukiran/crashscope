/**
 * Top-level barrel for crashscope adapter implementations. Aggregates the
 * error-tracking and session-replay sub-barrels so consumers can import every
 * adapter via `@pradhankukiran/crashscope-core/adapters`.
 */
export * from "./errors/index.js";
export * from "./sessions/index.js";
