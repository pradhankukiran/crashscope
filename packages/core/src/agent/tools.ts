import { z } from "zod";
import { confidenceSchema } from "../types/report.js";

/** Hard caps mirrored in both the JSON schema and the Zod validator. */
export const HYPOTHESIS_MAX = 280;
export const ROOT_CAUSE_MAX = 200;
export const USER_JOURNEY_MAX = 300;
export const SUGGESTED_FILES_MAX = 5;
/**
 * Per-item cap on the {@link suggestedFiles} array. A file path that exceeds
 * this is almost certainly hallucinated or pathological; truncating prevents
 * one runaway entry from polluting the rendered report.
 */
export const SUGGESTED_FILE_PATH_MAX = 256;

/**
 * Anthropic-format tool definition for emitting a structured triage finding.
 *
 * This is the JSON-Schema-flavored shape Claude expects in a `tools` array
 * (Anthropic Messages API or compatible transports). The Claude Agent SDK also
 * accepts this shape when exposed through MCP — the field names are identical.
 *
 * Keep the description tightly worded: it functions as the model-facing
 * instruction for *when* to call the tool, while the per-field descriptions
 * steer *what* to put in each slot.
 */
export const emitTriageFindingTool = {
  name: "emit_triage_finding",
  description:
    "Emit the structured triage finding for the current error. Call this " +
    "exactly once with your best hypothesis, root-cause guess, suggested " +
    "files to inspect, a brief user-journey summary, and your confidence level.",
  input_schema: {
    type: "object" as const,
    properties: {
      hypothesis: {
        type: "string",
        maxLength: HYPOTHESIS_MAX,
        description:
          "One sentence explaining what most likely went wrong in this error.",
      },
      rootCauseGuess: {
        type: "string",
        maxLength: ROOT_CAUSE_MAX,
        description:
          "The most plausible root cause expressed in concrete code/config terms.",
      },
      suggestedFiles: {
        type: "array",
        maxItems: SUGGESTED_FILES_MAX,
        items: { type: "string", maxLength: SUGGESTED_FILE_PATH_MAX },
        description:
          "Up to 5 file paths (relative or absolute) most worth opening first. " +
          "Infer from the stack trace and error type; omit when truly unknown.",
      },
      userJourney: {
        type: "string",
        maxLength: USER_JOURNEY_MAX,
        description:
          "1-2 sentences describing what the user was doing before the error. " +
          "If no session is available, say so plainly.",
      },
      confidence: {
        type: "string",
        enum: ["high", "med", "low"] as const,
        description:
          "Honest confidence in the hypothesis given available evidence.",
      },
    },
    required: [
      "hypothesis",
      "rootCauseGuess",
      "suggestedFiles",
      "userJourney",
      "confidence",
    ] as const,
    additionalProperties: false,
  },
} as const;

/**
 * Stable string name of the triage-finding tool, referenced by the
 * investigation loop when matching `tool_use` blocks in Claude's response.
 */
export const EMIT_TRIAGE_FINDING_TOOL_NAME =
  emitTriageFindingTool.name;

/**
 * Zod mirror of {@link emitTriageFindingTool.input_schema}.
 *
 * The SDK's MCP transport will already reject inputs that violate the JSON
 * schema, but we re-validate here because:
 * - Some transports forward the model's raw `tool_use.input` without strict
 *   schema enforcement (e.g. older API versions, custom proxies).
 * - It produces a typed object usable downstream without an extra cast.
 */
export const triageFindingSchema = z
  .object({
    hypothesis: z.string().min(1).max(HYPOTHESIS_MAX),
    rootCauseGuess: z.string().min(1).max(ROOT_CAUSE_MAX),
    suggestedFiles: z
      .array(z.string().min(1).max(SUGGESTED_FILE_PATH_MAX))
      .max(SUGGESTED_FILES_MAX),
    userJourney: z.string().min(1).max(USER_JOURNEY_MAX),
    confidence: confidenceSchema,
  })
  .strict();

export type TriageFinding = z.infer<typeof triageFindingSchema>;
