/**
 * Agent-level barrel for crashscope's AI investigation module.
 *
 * This re-exports the public surface consumed by the CLI / orchestrator. The
 * package-root barrel (`src/index.ts`) is owned by the maintainer; we keep
 * this scoped barrel so the agent module can be imported via
 * `@pradhankukiran/crashscope-core/agent` if/when the root re-exports it.
 */
export { investigate } from "./investigate.js";
export type { InvestigateInput } from "./investigate.js";
export { resolveAnthropicAuth } from "./auth.js";
export type { AuthResolution } from "./auth.js";
export {
  buildInvestigationPrompt,
  sanitizeForPrompt,
  MAX_PROMPT_CHARS,
} from "./prompt.js";
export {
  emitTriageFindingTool,
  EMIT_TRIAGE_FINDING_TOOL_NAME,
  triageFindingSchema,
  HYPOTHESIS_MAX,
  ROOT_CAUSE_MAX,
  USER_JOURNEY_MAX,
  SUGGESTED_FILES_MAX,
  SUGGESTED_FILE_PATH_MAX,
} from "./tools.js";
export type { TriageFinding } from "./tools.js";
