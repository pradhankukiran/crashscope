import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { NormalizedError } from "../types/error.js";
import type { NormalizedSession } from "../types/session.js";
import type { TriageIssue } from "../types/report.js";
import { ValidationError } from "../errors.js";
import { buildInvestigationPrompt } from "./prompt.js";
import {
  triageFindingSchema,
  type TriageFinding,
} from "./tools.js";
import type { AuthResolution } from "./auth.js";

/**
 * Input to {@link investigate}.
 *
 * `sessions` is a map from `errorId` → session (or `null` when no session was
 * found). The caller (CLI / orchestrator) is responsible for the join.
 */
export interface InvestigateInput {
  errors: NormalizedError[];
  sessions: Map<string, NormalizedSession | null>;
  auth: AuthResolution;
  /** Override the default Claude model. */
  model?: string;
  /** Max concurrent in-flight investigations. Default 3. */
  maxConcurrent?: number;
  /**
   * Hard cap on number of issues investigated in one batch. Anything beyond
   * this is sliced off (oldest order preserved) and announced via
   * {@link InvestigateInput.onWarning}. Default {@link DEFAULT_MAX_ISSUES}.
   */
  maxIssues?: number;
  /**
   * Per-call timeout in milliseconds. Each individual Claude call is wrapped
   * in a timeout-aware {@link AbortSignal}. Defaults to
   * {@link DEFAULT_PER_ISSUE_TIMEOUT_MS}.
   */
  perIssueTimeoutMs?: number;
  /** Cancellation signal forwarded to the SDK. */
  signal?: AbortSignal;
  /**
   * Optional callback for non-fatal warnings (e.g. "input clipped to N issues").
   * Don't silently drop work — surface it so the caller can log or display it.
   */
  onWarning?: (msg: string) => void;
}

/**
 * Default Claude model used when the caller doesn't pin one.
 *
 * Sonnet is the sweet spot for triage: cheaper than Opus, faster than Haiku
 * for structured reasoning, and supports tool use natively.
 */
const DEFAULT_MODEL = "claude-sonnet-4-5";

/** Name of the in-process MCP server we register the triage tool under. */
const MCP_SERVER_NAME = "crashscope";

/**
 * The SDK exposes MCP tools as `mcp__<server>__<tool>`. Capture this once so
 * we can pass it to `allowedTools` and recognise the tool in messages.
 */
const ALLOWED_TOOL_NAME = `mcp__${MCP_SERVER_NAME}__emit_triage_finding`;

/** Retry plan: 1s, 3s, 9s with up to ±20% jitter, then give up. */
const RETRY_DELAYS_MS = [1_000, 3_000, 9_000] as const;

/** HTTP status codes we consider transient and worth retrying. */
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * Default cap on the number of issues investigated in a single batch. Sized
 * to absorb a typical "last 24h" window from a small/medium service while
 * still bounding Anthropic spend. Override via
 * {@link InvestigateInput.maxIssues}.
 */
const DEFAULT_MAX_ISSUES = 100;

/**
 * Default per-call timeout (2 minutes). Sonnet under tool use rarely needs
 * this long; the timeout is a backstop against hung streams, not normal latency.
 */
const DEFAULT_PER_ISSUE_TIMEOUT_MS = 120_000;

/**
 * Tiny semaphore — limits concurrent investigations without pulling in
 * `p-limit` or `async-sema`. Capacity-bounded async lock.
 */
function createSemaphore(max: number): {
  acquire: () => Promise<() => void>;
} {
  let active = 0;
  const queue: Array<() => void> = [];
  const release = (): void => {
    active--;
    const next = queue.shift();
    if (next) {
      active++;
      next();
    }
  };
  return {
    acquire: () =>
      new Promise<() => void>((resolve) => {
        const grant = (): void => resolve(release);
        if (active < max) {
          active++;
          grant();
        } else {
          queue.push(grant);
        }
      }),
  };
}

/**
 * Decide whether an error thrown during a Claude call is worth retrying.
 *
 * The agent SDK surfaces transport errors as plain `Error`s whose messages
 * contain HTTP status codes (e.g. "Anthropic API 429..."). It also surfaces
 * abort/cancellation, which we never retry.
 */
function isTransientError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === "AbortError") return false;
    const message = err.message.toLowerCase();
    if (message.includes("aborted")) return false;
    for (const code of TRANSIENT_STATUSES) {
      if (message.includes(String(code))) return true;
    }
    // Network blips and generic fetch failures are also worth one more try.
    if (
      message.includes("econnreset") ||
      message.includes("etimedout") ||
      message.includes("network") ||
      message.includes("fetch failed") ||
      message.includes("socket hang up")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Sleep with jitter. Resolves early (with rejection) when `signal` aborts so
 * cancellation propagates through the retry loop.
 */
function sleepWithJitter(
  baseMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const jitter = 1 + (Math.random() * 0.4 - 0.2); // ±20%
    const delay = Math.max(0, Math.round(baseMs * jitter));
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Bridge between a user-supplied {@link AbortSignal} and the SDK's
 * {@link AbortController}-shaped option. Returns an abort controller that
 * tracks `external` while still allowing us to abort independently (e.g.
 * after a successful tool call).
 */
function makeAbortController(external?: AbortSignal): AbortController {
  const controller = new AbortController();
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else
      external.addEventListener(
        "abort",
        () => controller.abort(external.reason),
        { once: true },
      );
  }
  return controller;
}

/**
 * Combine a user-supplied signal with a per-call timeout signal. We can't
 * rely on `AbortSignal.any` being available everywhere (Node 18 LTS lacked
 * it), so we DIY when needed. `AbortSignal.timeout` is in Node 17.3+ which
 * is below our floor, so we use it directly.
 */
function combineSignals(
  userSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!userSignal) return timeoutSignal;
  // Prefer the platform implementation when present.
  const anyFn = (
    AbortSignal as unknown as {
      any?: (signals: AbortSignal[]) => AbortSignal;
    }
  ).any;
  if (typeof anyFn === "function") {
    return anyFn([userSignal, timeoutSignal]);
  }
  // Manual fallback: forward whichever fires first.
  const controller = new AbortController();
  const forward = (reason: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  if (userSignal.aborted) forward(userSignal.reason);
  else userSignal.addEventListener("abort", () => forward(userSignal.reason), { once: true });
  if (timeoutSignal.aborted) forward(timeoutSignal.reason);
  else
    timeoutSignal.addEventListener("abort", () => forward(timeoutSignal.reason), {
      once: true,
    });
  return controller.signal;
}

/**
 * Z-shaped raw shape mirror of {@link triageFindingSchema} for the SDK tool().
 *
 * The SDK accepts either zod v3 or v4 raw shapes; we keep this in v3 since
 * the rest of `@crashscope/core` is on zod v3.
 */
const triageFindingRawShape = {
  hypothesis: z.string().min(1).max(280),
  rootCauseGuess: z.string().min(1).max(200),
  suggestedFiles: z.array(z.string().min(1)).max(5),
  userJourney: z.string().min(1).max(300),
  confidence: z.enum(["high", "med", "low"]),
};

/**
 * Run a single Claude call for one error. Returns the captured finding on
 * success; throws on auth failure, abort, or repeated transient failure.
 *
 * The function constructs a fresh in-process MCP server per call so the
 * captured-args closure is isolated — sharing one server across concurrent
 * calls would race on the shared variable.
 */
async function runOnce(
  error: NormalizedError,
  session: NormalizedSession | null,
  auth: AuthResolution,
  model: string,
  signal: AbortSignal | undefined,
  perIssueTimeoutMs: number,
): Promise<TriageFinding> {
  let captured: TriageFinding | null = null;
  const combinedSignal = combineSignals(signal, perIssueTimeoutMs);
  const controller = makeAbortController(combinedSignal);

  const mcpServer = createSdkMcpServer({
    name: MCP_SERVER_NAME,
    tools: [
      tool(
        "emit_triage_finding",
        "Emit the structured triage finding for the current error.",
        triageFindingRawShape,
        async (args) => {
          // Validate with our own schema. If the SDK ever forwards unchecked
          // input (e.g. via a transport that skips JSON schema enforcement),
          // this still rejects malformed payloads.
          const parsed = triageFindingSchema.safeParse(args);
          if (!parsed.success) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    "Validation failed: " +
                    parsed.error.issues
                      .map((i) => `${i.path.join(".")}: ${i.message}`)
                      .join("; "),
                },
              ],
              isError: true,
            };
          }
          captured = parsed.data;
          return {
            content: [
              { type: "text", text: "Finding recorded. End your turn now." },
            ],
          };
        },
      ),
    ],
  });

  const env: Record<string, string | undefined> = { ...process.env };
  if (auth.mode === "api-key") {
    env["ANTHROPIC_API_KEY"] = auth.apiKey;
  }

  const prompt = buildInvestigationPrompt(error, session);

  const stream = query({
    prompt,
    options: {
      model,
      systemPrompt:
        "You are a precise production-error triage agent. Respond ONLY by " +
        "calling the `emit_triage_finding` MCP tool exactly once. Do not " +
        "use any other tools and do not produce free-form prose.",
      mcpServers: { [MCP_SERVER_NAME]: mcpServer },
      allowedTools: [ALLOWED_TOOL_NAME],
      // Disable Claude Code's built-in tools — we only want the model to
      // call our MCP tool.
      tools: [],
      maxTurns: 3,
      abortController: controller,
      env,
      // No need to persist sessions for one-shot calls.
      persistSession: false,
    },
  });

  let lastErrorMessage: string | null = null;
  for await (const msg of stream) {
    if (msg.type === "result" && msg.subtype !== "success") {
      // The SDK emits a final non-success result on auth/budget/turn limits.
      lastErrorMessage =
        msg.errors && msg.errors.length > 0
          ? msg.errors.join("; ")
          : `agent ended with subtype ${msg.subtype}`;
    }
  }

  if (!captured) {
    throw new Error(
      lastErrorMessage ??
        "Claude completed without calling emit_triage_finding.",
    );
  }
  return captured;
}

/**
 * Run a Claude investigation for one error with retry on transient failures.
 *
 * Retries:
 * - 3 attempts total ({@link RETRY_DELAYS_MS}).
 * - Only retries when {@link isTransientError} returns true.
 * - Aborts immediately when the caller's signal fires.
 */
async function investigateOne(
  error: NormalizedError,
  session: NormalizedSession | null,
  auth: AuthResolution,
  model: string,
  signal: AbortSignal | undefined,
  perIssueTimeoutMs: number,
): Promise<TriageFinding | { error: string }> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (signal?.aborted) {
      return {
        error: "Investigation cancelled before completion.",
      };
    }
    try {
      return await runOnce(error, session, auth, model, signal, perIssueTimeoutMs);
    } catch (err: unknown) {
      lastErr = err;
      if (err instanceof ValidationError) {
        // Validation issues are not transient — fail fast.
        return { error: `Tool output validation failed: ${err.message}` };
      }
      if (!isTransientError(err) || attempt === RETRY_DELAYS_MS.length) {
        break;
      }
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      try {
        await sleepWithJitter(delay, signal);
      } catch {
        return { error: "Investigation cancelled during retry backoff." };
      }
    }
  }
  const message =
    lastErr instanceof Error ? lastErr.message : String(lastErr ?? "unknown");
  return { error: message };
}

/**
 * Assemble a {@link TriageIssue} from the deterministic error/session fields
 * plus Claude's finding (or a failure placeholder).
 */
function assembleIssue(
  error: NormalizedError,
  session: NormalizedSession | null,
  finding: TriageFinding | { error: string },
): TriageIssue {
  const base: Omit<
    TriageIssue,
    "hypothesis" | "rootCauseGuess" | "suggestedFiles" | "userJourney" | "confidence"
  > = {
    errorId: error.id,
    severity: error.severity,
    provider: error.provider,
    title: error.title,
    affectedUsers: error.affectedUsers,
    eventCount: error.eventCount,
    firstSeen: error.firstSeen,
    lastSeen: error.lastSeen,
    environment: error.environment,
    releaseVersion: error.releaseVersion,
    sourceUrl: error.sourceUrl,
    replayUrl: session?.replayUrl ?? null,
    sessionId: session?.id ?? null,
  };

  if ("error" in finding) {
    return {
      ...base,
      hypothesis: `Investigation failed: ${finding.error}`,
      rootCauseGuess: "Unknown — Claude call did not complete successfully.",
      suggestedFiles: [],
      userJourney: session
        ? "Session present but not analyzed due to investigation failure."
        : "No session data was available and investigation did not complete.",
      confidence: "low",
    };
  }

  return {
    ...base,
    hypothesis: finding.hypothesis,
    rootCauseGuess: finding.rootCauseGuess,
    suggestedFiles: finding.suggestedFiles,
    userJourney: finding.userJourney,
    confidence: finding.confidence,
  };
}

/**
 * Run the AI investigation across a batch of normalized errors.
 *
 * Concurrency: at most `maxConcurrent` calls in flight at once (default 3).
 * Each error gets its own retry loop; one failure never blocks others.
 *
 * Input volume is bounded by `maxIssues` (default {@link DEFAULT_MAX_ISSUES}).
 * Excess is sliced off and surfaced via `onWarning` rather than silently
 * dropped — callers should always see when work was clipped.
 *
 * The returned array is in the same order as `input.errors` so downstream
 * formatters can rely on input ordering.
 */
export async function investigate(
  input: InvestigateInput,
): Promise<TriageIssue[]> {
  const { sessions, auth, signal, onWarning } = input;
  const model = input.model ?? DEFAULT_MODEL;
  const maxConcurrent = Math.max(1, input.maxConcurrent ?? 3);
  const maxIssues = Math.max(1, input.maxIssues ?? DEFAULT_MAX_ISSUES);
  const perIssueTimeoutMs = Math.max(
    1_000,
    input.perIssueTimeoutMs ?? DEFAULT_PER_ISSUE_TIMEOUT_MS,
  );

  let errors = input.errors;
  if (errors.length > maxIssues) {
    const dropped = errors.length - maxIssues;
    const warn =
      `crashscope: investigating only the first ${maxIssues} of ` +
      `${errors.length} errors (${dropped} dropped). Raise maxIssues to ` +
      `process more, or paginate upstream.`;
    if (onWarning) {
      onWarning(warn);
    } else {
      console.warn(`[crashscope/agent] ${warn}`);
    }
    errors = errors.slice(0, maxIssues);
  }

  const sem = createSemaphore(maxConcurrent);

  const tasks = errors.map(async (error) => {
    const release = await sem.acquire();
    try {
      const session = sessions.get(error.id) ?? null;
      const finding = await investigateOne(
        error,
        session,
        auth,
        model,
        signal,
        perIssueTimeoutMs,
      );
      return assembleIssue(error, session, finding);
    } finally {
      release();
    }
  });

  return Promise.all(tasks);
}
