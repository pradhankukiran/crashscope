/**
 * Barrel for crashscope's error-tracking adapter implementations.
 *
 * Each adapter implements {@link ErrorAdapter} from `@crashscope/core/types`.
 * Internal test hooks (e.g. Sentry's `__internal`) are deliberately not
 * re-exported here.
 */
export { SentryAdapter } from "./sentry.js";
export type { SentryAdapterOptions } from "./sentry.js";

export { RollbarAdapter } from "./rollbar.js";
export type { RollbarAdapterOptions } from "./rollbar.js";

export { BugsnagAdapter } from "./bugsnag.js";
export type { BugsnagAdapterOptions } from "./bugsnag.js";

export { HoneybadgerAdapter } from "./honeybadger.js";
export type { HoneybadgerAdapterOptions } from "./honeybadger.js";
