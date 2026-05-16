import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import chalk from "chalk";
import ora, { type Ora } from "ora";
import {
  AdapterError,
  AuthError,
  ConfigError,
  investigate,
  severitySchema,
  type CrashscopeConfig,
  type NormalizedError,
  type NormalizedSession,
  type OutputChannel,
  type Severity,
  type TriageIssue,
  type TriageReport,
} from "@pradhankukiran/crashscope-core";
import { createErrorAdapter, createSessionAdapter } from "../adapters/index.js";
import { detectAnthropicAuth } from "../auth/detect.js";
import { loadConfig } from "../config/load.js";
import { getDebugLogPath } from "../config/paths.js";
import {
  formatFromExtension,
  writeReportToFile,
  type FileFormat,
} from "../output/file.js";
import { printJsonReport } from "../output/json.js";
import { postSlackReport } from "../output/slack.js";
import { printTerminalReport } from "../output/terminal.js";
import { parseSince } from "../util/since.js";
import { redact } from "../util/redact.js";

/**
 * Maximum number of concurrent in-flight `fetchForUser` calls.
 *
 * Five gives us throughput without overwhelming session-provider rate limits
 * for the typical "fetch the latest 25 errors" workload. The investigate()
 * call below uses its own (lower) concurrency cap for Claude calls.
 */
const SESSION_CONCURRENCY = 5;

/** CLI-side spec parsed from commander flags. */
export interface TriageOptions {
  since: string;
  limit: number;
  severities: Severity[] | undefined;
  outputs: OutputChannel[] | undefined;
  json: boolean;
  /** Destination for `--out <path>`. When set the report is also written to disk. */
  out: string | undefined;
  /** Explicit `--format` override. When absent the extension on `out` decides. */
  format: FileFormat | undefined;
  /** Skip the Claude investigation step (set by `--dry-run`). */
  dryRun: boolean;
  debug: boolean;
  configPath: string | undefined;
}

/**
 * Entry point for `crashscope triage`.
 *
 * The function is structured as a linear pipeline (load → auth → fetch errors
 * → fetch sessions → investigate → render) so failure modes are easy to map
 * to exit codes (see {@link exitCodeFor} in util/exit). Each stage updates a
 * spinner so non-TTY runs (e.g. CI) still get a deterministic log trail.
 */
export async function runTriage(options: TriageOptions): Promise<void> {
  const startedAt = Date.now();
  const debugLog = options.debug ? await openDebugLog() : null;

  // SIGINT → AbortController. Two callers honour the signal:
  //   1. `investigate()` (core forwards the signal to the Anthropic SDK).
  //   2. `fetchSessionsForErrors` polls `signal.aborted` between worker
  //      iterations so an in-flight wave finishes (or fails) but new fetches
  //      stop being scheduled.
  // We install/uninstall the listener around the long-running work — keeping
  // it scoped means a second Ctrl+C after the listener is detached lets the
  // default handler tear the process down (no `--force` needed).
  const controller = new AbortController();
  const onSigint = (): void => {
    if (controller.signal.aborted) return;
    controller.abort(new Error("Cancelled by user"));
    process.stderr.write(chalk.yellow("\nCancelling…\n"));
  };
  process.once("SIGINT", onSigint);

  try {
    // ---- 1. Load + validate config -----------------------------------------
    const config = await loadConfig(options.configPath);

    // ---- 2. Resolve auth ---------------------------------------------------
    const auth = await detectAnthropicAuth(config.anthropic);
    if (!auth.ok) {
      // Throw an AuthError so the central handler emits exit code 3 with the
      // hint payload the detect wrapper already produced.
      throw new AuthError("anthropic", formatAuthFailure(auth.message, auth.hints));
    }

    // ---- 3. Instantiate adapters from config ------------------------------
    const errorAdapter = createErrorAdapter(config);
    const sessionAdapter = createSessionAdapter(config);

    // ---- 4. Resolve outputs ------------------------------------------------
    // CLI flag overrides config; `--json` is a convenience alias. We dedupe so
    // a user passing `--output terminal,terminal` doesn't print twice.
    const outputs: OutputChannel[] = dedupe(
      options.json
        ? ["json"]
        : (options.outputs ?? config.outputs),
    );

    // ---- 5. Parse --since --------------------------------------------------
    const { date: sinceDate, windowLabel } = parseSince(options.since);

    // ---- 6. Fetch errors ---------------------------------------------------
    const useSpinners = process.stdout.isTTY === true && !outputs.includes("json");
    const fetchSpin = makeSpinner(useSpinners, "Fetching errors from " + config.errorProvider + "...", "📡");
    let errors: NormalizedError[];
    try {
      const fetchOpts: Parameters<typeof errorAdapter.fetchRecent>[0] = {
        since: sinceDate,
        limit: options.limit,
      };
      if (options.severities && options.severities.length > 0) {
        fetchOpts.severities = options.severities;
      }
      errors = await errorAdapter.fetchRecent(fetchOpts);
      throwIfAborted(controller.signal);
      fetchSpin.succeed(`Fetched ${errors.length} errors from ${config.errorProvider}`);
    } catch (err: unknown) {
      fetchSpin.fail(`Failed to fetch errors from ${config.errorProvider}`);
      await writeDebug(debugLog, "fetchRecent", err);
      throw normalizeError(err, config.errorProvider);
    }

    // Early exit for empty result sets — produce an empty report so JSON / CI
    // consumers always get a parseable payload. A "no issues" run is the
    // most common reason new users get confused ("did it work?"), so we drop
    // a single hint on stderr pointing them at the wider window flag and the
    // bundled test harness.
    if (errors.length === 0) {
      const emptyReport = buildReport({
        issues: [],
        config,
        windowLabel,
        durationMs: Date.now() - startedAt,
      });
      await emitOutputs(emptyReport, outputs, config);
      await maybeWriteToFile(emptyReport, options);
      printEmptyStateHint();
      return;
    }

    // ---- 7. Fetch sessions in parallel (bounded concurrency) --------------
    const sessionsSpin = makeSpinner(useSpinners, "Matching sessions...", "🎬");
    const sessions = await fetchSessionsForErrors(
      errors,
      sessionAdapter,
      SESSION_CONCURRENCY,
      debugLog,
      controller.signal,
    );
    throwIfAborted(controller.signal);
    const matched = Array.from(sessions.values()).filter((s) => s !== null).length;
    sessionsSpin.succeed(`Matched ${matched}/${errors.length} sessions`);

    // ---- 8a. Dry run --------------------------------------------------------
    // `--dry-run` skips the Claude investigation step so the user can verify
    // their config (provider auth, session matching, severity filters) before
    // spending any LLM tokens. We still emit a report shaped like the regular
    // path, but every issue carries a placeholder finding so JSON consumers
    // see the same schema. Slack delivery is silenced because shipping
    // placeholder findings into a channel would just be noise.
    if (options.dryRun) {
      const dryIssues: TriageIssue[] = errors.map((error) =>
        assembleDryRunIssue(error, sessions.get(error.id) ?? null),
      );
      const dryReport = buildReport({
        issues: dryIssues,
        config,
        windowLabel,
        durationMs: Date.now() - startedAt,
      });
      const dryOutputs = outputs.filter((o) => o !== "slack");
      await emitOutputs(dryReport, dryOutputs, config);
      await maybeWriteToFile(dryReport, options);
      process.stderr.write(
        chalk.yellow(
          `Dry run — Claude investigation skipped. Listed ${errors.length} errors and ${matched} matched sessions.\n`,
        ),
      );
      return;
    }

    // ---- 8. Investigate with Claude ---------------------------------------
    const investigateSpin = makeSpinner(
      useSpinners,
      `Investigating with Claude (0/${errors.length})...`,
      "🤖",
    );
    // The current `investigate()` is not progress-streaming. We approximate
    // progress by re-rendering the spinner text every 2s with a tick counter so
    // long runs don't look frozen. The loop also checks for abort so a Ctrl+C
    // updates the spinner text immediately while the underlying SDK call wraps
    // up.
    let elapsedTicks = 0;
    const tickInterval = useSpinners
      ? setInterval(() => {
          elapsedTicks += 1;
          if (controller.signal.aborted) {
            investigateSpin.text =
              `Cancelling investigation (${elapsedTicks * 2}s)...`;
            return;
          }
          investigateSpin.text =
            `Investigating with Claude (${elapsedTicks * 2}s elapsed, ${errors.length} issues)...`;
        }, 2_000)
      : null;
    let issues: TriageIssue[];
    try {
      issues = await investigate({
        errors,
        sessions,
        auth: auth.resolution,
        signal: controller.signal,
      });
      investigateSpin.succeed(`Investigated ${issues.length} issues`);
    } catch (err: unknown) {
      investigateSpin.fail("Investigation failed");
      await writeDebug(debugLog, "investigate", err);
      // If the signal aborted we exit with the conventional 130 code rather
      // than reporting the cancellation as a generic adapter failure.
      if (controller.signal.aborted) {
        process.exit(130);
      }
      throw normalizeError(err, "anthropic");
    } finally {
      if (tickInterval) clearInterval(tickInterval);
    }

    // ---- 9. Assemble report -----------------------------------------------
    const report = buildReport({
      issues,
      config,
      windowLabel,
      durationMs: Date.now() - startedAt,
    });

    // ---- 10. Emit to selected outputs -------------------------------------
    await emitOutputs(report, outputs, config);
    await maybeWriteToFile(report, options);
  } finally {
    process.off("SIGINT", onSigint);
  }
}

/**
 * Throw an `Error` (with name "AbortError") when the signal is already
 * aborted. Callers use this between long-running stages so a Ctrl+C between
 * `fetchRecent` and `fetchSessionsForErrors` doesn't waste API calls.
 *
 * We intentionally throw a plain `Error` named "AbortError" rather than the
 * DOM `DOMException` (the latter exists in Node 20+ but pulling it into typed
 * code adds a `lib: ["DOM"]` requirement we'd rather avoid).
 */
function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason: unknown = signal.reason;
  if (reason instanceof Error) {
    const wrapped = new Error(reason.message);
    wrapped.name = "AbortError";
    throw wrapped;
  }
  const err = new Error("Aborted");
  err.name = "AbortError";
  throw err;
}

/**
 * Build a `TriageReport` from issues + config metadata.
 *
 * Centralised so the empty-results branch and the regular branch produce
 * identically-shaped reports.
 */
function buildReport(input: {
  issues: TriageIssue[];
  config: CrashscopeConfig;
  windowLabel: string;
  durationMs: number;
}): TriageReport {
  const summary = bucketIssues(input.issues);
  return {
    generatedAt: new Date().toISOString(),
    window: input.windowLabel,
    summary,
    issues: input.issues,
    meta: {
      errorProvider: input.config.errorProvider,
      sessionProvider: input.config.sessionProvider,
      durationMs: input.durationMs,
    },
  };
}

/**
 * Compute the high/med/low buckets used in the report summary.
 *
 * Mirrors the bucket assignment in `output/terminal.ts` so terminal and JSON
 * summaries agree.
 */
function bucketIssues(issues: TriageIssue[]): TriageReport["summary"] {
  let high = 0;
  let med = 0;
  let low = 0;
  for (const issue of issues) {
    switch (issue.severity) {
      case "fatal":
      case "error":
        high++;
        break;
      case "warning":
        med++;
        break;
      case "info":
        low++;
        break;
    }
  }
  return { high, med, low, total: issues.length };
}

/**
 * Fetch sessions for each error's sample user (when available) with bounded
 * concurrency, returning the map shape expected by {@link investigate}.
 *
 * Errors *during* a single session fetch are swallowed — a single missing
 * replay should never derail an entire triage run. The error is captured in
 * the debug log when `--debug` is on.
 */
async function fetchSessionsForErrors(
  errors: NormalizedError[],
  sessionAdapter: ReturnType<typeof createSessionAdapter>,
  concurrency: number,
  debugLog: DebugLog | null,
  signal: AbortSignal,
): Promise<Map<string, NormalizedSession | null>> {
  const out = new Map<string, NormalizedSession | null>();
  let cursor = 0;
  const workers: Promise<void>[] = [];

  const next = async (): Promise<void> => {
    while (cursor < errors.length) {
      // Polling the signal between iterations is cheap and lets a Ctrl+C
      // short-circuit the remaining queue without waiting for an in-flight
      // adapter call to fail. The SessionAdapter contract doesn't (yet)
      // accept an AbortSignal so we can't pre-empt the active fetch itself.
      if (signal.aborted) return;
      const idx = cursor++;
      const error = errors[idx];
      if (!error) continue;
      const userId = error.sampleUserIds[0];
      if (!userId) {
        out.set(error.id, null);
        continue;
      }
      try {
        const session = await sessionAdapter.fetchForUser({
          userId,
          around: new Date(error.lastSeen),
        });
        out.set(error.id, session);
      } catch (err: unknown) {
        await writeDebug(debugLog, `fetchForUser:${error.id}`, err);
        out.set(error.id, null);
      }
    }
  };

  const lanes = Math.max(1, Math.min(concurrency, errors.length));
  for (let i = 0; i < lanes; i++) workers.push(next());
  await Promise.all(workers);
  // Ensure every error has an entry even when we cancelled early — investigate
  // sets the per-error `session` to null when missing.
  for (const error of errors) {
    if (!out.has(error.id)) out.set(error.id, null);
  }
  return out;
}

/**
 * Build a placeholder {@link TriageIssue} for `--dry-run`.
 *
 * The function copies the deterministic fields (severity, title, counts,
 * URLs) from the source error so the user can see which issues *would* be
 * investigated, and fills the LLM-derived fields with explicit
 * "Skipped (dry run)" sentinels so JSON consumers don't confuse the report
 * with a real investigation.
 */
function assembleDryRunIssue(
  error: NormalizedError,
  session: NormalizedSession | null,
): TriageIssue {
  return {
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
    hypothesis: "Skipped (dry run) — re-run without --dry-run to investigate.",
    rootCauseGuess: "Skipped (dry run).",
    suggestedFiles: [],
    userJourney:
      session
        ? "Session matched but not analysed because --dry-run was set."
        : "No session matched for this error.",
    confidence: "low",
  };
}

/**
 * Resolve the `FileFormat` for a `--out <path>` write.
 *
 * Precedence: explicit `--format` flag, then extension on `--out`. Throws a
 * `RangeError` (mapped to exit code 1 by the central handler) when neither
 * source produces a recognised format.
 */
function resolveFileFormat(
  out: string,
  explicit: FileFormat | undefined,
): FileFormat {
  if (explicit !== undefined) return explicit;
  const fromExt = formatFromExtension(out);
  if (fromExt !== null) return fromExt;
  throw new RangeError(
    `Cannot infer output format from "${out}". Pass --format md|json|terminal.`,
  );
}

/**
 * Write `report` to `--out` if requested.
 *
 * Kept as a separate helper so both the empty-results branch and the regular
 * branch produce identical disk artefacts. ENOENT from `writeFile` is
 * surfaced verbatim — we deliberately do not create parent directories so a
 * user typo doesn't silently scatter files across the home directory.
 */
async function maybeWriteToFile(
  report: TriageReport,
  options: TriageOptions,
): Promise<void> {
  if (options.out === undefined) return;
  const format = resolveFileFormat(options.out, options.format);
  try {
    const written = await writeReportToFile(report, options.out, format);
    process.stderr.write(
      chalk.green(`Wrote ${format} report to ${written}\n`),
    );
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Cannot write to "${options.out}" — parent directory does not exist.`,
      );
    }
    throw err;
  }
}

/**
 * Parser used by commander for the `--format` flag.
 *
 * Exposed alongside the other parsers so the entry point can wrap it via
 * `wrapParser` and surface the same `InvalidArgumentError` shape on misuse.
 */
export function parseFileFormat(value: string): FileFormat {
  const lowered = value.toLowerCase();
  if (lowered === "md" || lowered === "markdown") return "md";
  if (lowered === "json") return "json";
  if (lowered === "terminal" || lowered === "txt") return "terminal";
  throw new RangeError(
    `Invalid --format value "${value}". Expected md, json, or terminal.`,
  );
}

/**
 * Print the empty-state hint to stderr.
 *
 * Kept on stderr (not stdout) so JSON consumers still get a clean parseable
 * report on stdout while the user gets a usability nudge in their terminal.
 * The wording matches the suggestion in the README so the user has one place
 * to look up the wider-window flag without reading the help output.
 */
function printEmptyStateHint(): void {
  process.stderr.write(
    chalk.yellow(
      "No issues found. Try `crashscope triage --since 7d`, or generate test data with the harness at examples/test-app/.\n",
    ),
  );
}

/**
 * Deliver `report` to each selected output channel in sequence.
 *
 * Slack and terminal are awaited so an error in Slack delivery still surfaces
 * a non-zero exit code; JSON is the final fallthrough so JSON consumers see
 * the report on stdout even if Slack failed (with a stderr warning).
 */
async function emitOutputs(
  report: TriageReport,
  outputs: OutputChannel[],
  config: CrashscopeConfig,
): Promise<void> {
  if (outputs.includes("terminal")) {
    printTerminalReport(report);
  }
  if (outputs.includes("slack")) {
    try {
      await postSlackReport(report, config);
    } catch (err: unknown) {
      process.stderr.write(
        chalk.red(
          `Slack delivery failed: ${err instanceof Error ? redact(err.message) : String(err)}\n`,
        ),
      );
      // Re-throw so the entry-point handler emits exit code 2.
      throw err;
    }
  }
  if (outputs.includes("json")) {
    printJsonReport(report);
  }
}

/**
 * `ora`-shaped spinner abstraction with a no-op fallback for non-TTY runs.
 *
 * We return a uniform interface (`succeed` / `fail` / mutable `text`) so the
 * triage flow doesn't sprout `if (spinner)` guards at every stage.
 */
function makeSpinner(active: boolean, text: string, emoji: string): Ora {
  if (!active) {
    // Return a stub that mimics the spinner API but writes plain lines so
    // piped/CI output stays useful.
    return {
      start() {
        process.stderr.write(`${emoji} ${text}\n`);
        return this;
      },
      stop() {
        return this;
      },
      succeed(message?: string) {
        if (message) process.stderr.write(`✓ ${message}\n`);
        return this;
      },
      fail(message?: string) {
        if (message) process.stderr.write(`✗ ${message}\n`);
        return this;
      },
      info() {
        return this;
      },
      warn() {
        return this;
      },
      clear() {
        return this;
      },
      render() {
        return this;
      },
      frame() {
        return "";
      },
      text,
      prefixText: "",
      suffixText: "",
      color: "white",
      indent: 0,
      spinner: "dots",
      isSpinning: false,
      // ora has a few more fields; we cast through `unknown` because Ora is a
      // class and stubs here only need the methods used in this module.
    } as unknown as Ora;
  }
  return ora({ text: `${emoji} ${text}`, stream: process.stderr }).start();
}

/** De-duplicate a list while preserving original order. */
function dedupe<T>(values: readonly T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * Map adapter / fetch failures to the appropriate crashscope error class.
 *
 * Adapters throw {@link AdapterError} already; this wrapper handles the case
 * where a stray `Error` slips through (e.g. a `fetch` network throw before
 * the adapter wraps it).
 */
function normalizeError(err: unknown, provider: string): Error {
  if (err instanceof AdapterError) return err;
  if (err instanceof AuthError) return err;
  if (err instanceof ConfigError) return err;
  if (err instanceof Error) {
    return new AdapterError(provider, err.message, { cause: err });
  }
  return new AdapterError(provider, String(err));
}

/**
 * Format the auth-failure body that propagates up to the entry-point handler.
 *
 * We pre-stringify hints into the message so the top-level renderer doesn't
 * need to know about `AuthDetection`.
 */
function formatAuthFailure(message: string, hints: readonly string[]): string {
  if (hints.length === 0) return message;
  return [message, "Try one of:", ...hints.map((h) => `  - ${h}`)].join("\n");
}

/** Handle for the optional debug log appended to ~/.crashscope/debug.log. */
interface DebugLog {
  path: string;
}

/**
 * Initialise the debug log file (create directory, write a banner).
 *
 * Returns a tiny handle the rest of the flow uses for `writeDebug` calls.
 */
async function openDebugLog(): Promise<DebugLog> {
  const path = getDebugLogPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(
    path,
    `\n=== crashscope triage @ ${new Date().toISOString()} ===\n`,
  );
  return { path };
}

/**
 * Append a single labelled record to the debug log, with credentials redacted.
 *
 * The `tag` lets us recognise which stage produced the line ("fetchRecent",
 * "fetchForUser:abc", "investigate") when reading the file by hand.
 */
async function writeDebug(
  debug: DebugLog | null,
  tag: string,
  payload: unknown,
): Promise<void> {
  if (!debug) return;
  const body =
    payload instanceof Error
      ? `${payload.name}: ${payload.message}\n${payload.stack ?? ""}`
      : JSON.stringify(payload, null, 2);
  const line = `[${new Date().toISOString()}] ${tag}\n${redact(body)}\n`;
  try {
    await appendFile(debug.path, line);
  } catch {
    // Debug logging must never crash the triage flow.
  }
}

/**
 * Parser used by commander for the `--severity` CSV flag.
 *
 * Exposed for the entry point so the option parsing logic lives next to the
 * other CLI option helpers.
 */
export function parseSeverityList(value: string): Severity[] {
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const result: Severity[] = [];
  for (const item of items) {
    const parsed = severitySchema.safeParse(item);
    if (!parsed.success) {
      throw new RangeError(
        `Invalid --severity value "${item}". Expected fatal, error, warning, or info.`,
      );
    }
    result.push(parsed.data);
  }
  return result;
}

/**
 * Parser used by commander for the `--output` CSV flag.
 */
export function parseOutputList(value: string): OutputChannel[] {
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const validChannels: OutputChannel[] = ["terminal", "slack", "json"];
  const result: OutputChannel[] = [];
  for (const item of items) {
    if ((validChannels as string[]).includes(item)) {
      result.push(item as OutputChannel);
    } else {
      throw new RangeError(
        `Invalid --output value "${item}". Expected terminal, slack, or json.`,
      );
    }
  }
  return result;
}

/**
 * Parser used by commander for `--limit`.
 *
 * Rejects non-positive integers so adapters never receive `0` or `-1` as a
 * page size.
 */
export function parseLimit(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new RangeError(`Invalid --limit value "${value}". Expected a positive integer.`);
  }
  return n;
}
