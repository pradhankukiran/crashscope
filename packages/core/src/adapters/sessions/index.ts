/**
 * Barrel for crashscope's session-replay adapter implementations.
 *
 * Each adapter implements {@link SessionAdapter} from `@crashscope/core/types`.
 */
export { PostHogAdapter } from "./posthog.js";
export type { PostHogAdapterOptions } from "./posthog.js";

export { LogRocketAdapter } from "./logrocket.js";
