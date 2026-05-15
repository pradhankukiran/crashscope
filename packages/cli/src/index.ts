import chalk from "chalk";
import { Command, InvalidArgumentError } from "commander";
import {
  AdapterError,
  AuthError,
  ConfigError,
  ValidationError,
} from "@crashscope/core";
import { runConfig, type ConfigAction } from "./commands/config.js";
import { runInit } from "./commands/init.js";
import {
  parseLimit,
  parseOutputList,
  parseSeverityList,
  runTriage,
} from "./commands/triage.js";
import { exitCodeFor } from "./util/exit.js";
import { redact } from "./util/redact.js";
import { VERSION } from "./version.js";

/**
 * Build the `commander` program tree.
 *
 * Each sub-command's `.action()` body is a thin trampoline into the
 * corresponding `commands/*.ts` module so the heavy lifting lives next to
 * the data flow and the entry point stays focused on argv plumbing.
 */
function buildProgram(): Command {
  const program = new Command();
  program
    .name("crashscope")
    .description(
      "AI-powered error triage CLI: fetch recent errors from Sentry / Rollbar / " +
        "Bugsnag / Honeybadger, join with PostHog or LogRocket session replays, " +
        "and triage with Claude.",
    )
    .version(VERSION, "-v, --version", "Print the crashscope version and exit.")
    .showHelpAfterError("(use `crashscope --help` for usage)")
    .configureOutput({
      writeErr: (str) => process.stderr.write(str),
    });

  program
    .command("init")
    .description("Run the interactive setup wizard and write ~/.crashscope/config.json.")
    .option("--config <path>", "Write to an alternate config path.")
    .action(async (opts: { config?: string }) => {
      await runInit({ ...(opts.config ? { configPath: opts.config } : {}) });
    });

  program
    .command("triage")
    .description("Fetch recent errors, match sessions, and triage with Claude.")
    .option(
      "--since <duration>",
      "Time window to consider (e.g. 1h, 24h, 7d).",
      "24h",
    )
    .option(
      "--limit <n>",
      "Maximum number of errors to triage.",
      wrapParser(parseLimit),
      25,
    )
    .option(
      "--severity <list>",
      "Comma-separated severities to include (fatal,error,warning,info).",
      wrapParser(parseSeverityList),
    )
    .option(
      "--output <list>",
      "Comma-separated outputs (terminal,slack,json). Overrides config.",
      wrapParser(parseOutputList),
    )
    .option("--json", "Alias for --output json.")
    .option("--debug", "Verbose tracebacks and a debug log at ~/.crashscope/debug.log.")
    .option("--config <path>", "Load an alternate config file.")
    .action(
      async (opts: {
        since: string;
        limit: number;
        severity?: ReturnType<typeof parseSeverityList>;
        output?: ReturnType<typeof parseOutputList>;
        json?: boolean;
        debug?: boolean;
        config?: string;
      }) => {
        await runTriage({
          since: opts.since,
          limit: opts.limit,
          severities: opts.severity,
          outputs: opts.output,
          json: opts.json === true,
          debug: opts.debug === true,
          configPath: opts.config,
        });
      },
    );

  const configCmd = program
    .command("config")
    .description("Show, locate, or edit the crashscope config.");
  configCmd
    .command("show", { isDefault: true })
    .description("Print the current config with credentials masked.")
    .option("--config <path>", "Load an alternate config file.")
    .action(
      async (opts: { config?: string }) =>
        runConfig("show", optionalConfigPath(opts.config)),
    );
  configCmd
    .command("path")
    .description("Print the path crashscope would read or write.")
    .option("--config <path>", "Print this path instead of the default.")
    .action((opts: { config?: string }) =>
      runConfig("path", optionalConfigPath(opts.config)),
    );
  configCmd
    .command("edit")
    .description("Open the config in $EDITOR ($VISUAL takes precedence).")
    .option("--config <path>", "Edit an alternate config file.")
    .action(
      async (opts: { config?: string }) =>
        runConfig("edit" as ConfigAction, optionalConfigPath(opts.config)),
    );

  return program;
}

/**
 * Forward an optional `--config` flag in a way that respects
 * `exactOptionalPropertyTypes` — `{ configPath: undefined }` would fail the
 * type check, so we only attach the key when the user actually passed it.
 */
function optionalConfigPath(value: string | undefined): { configPath?: string } {
  return value !== undefined ? { configPath: value } : {};
}

/**
 * Adapt a `(raw: string) => T` parser into the commander coercion signature.
 *
 * Commander expects `(value, previous) => T`; we ignore `previous` (we don't
 * use repeated-option accumulation) and re-throw {@link RangeError} as
 * commander's {@link InvalidArgumentError} so the CLI surfaces the message
 * inline rather than as an uncaught exception.
 */
function wrapParser<T>(
  parser: (value: string) => T,
): (value: string) => T {
  return (value: string): T => {
    try {
      return parser(value);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new InvalidArgumentError(message);
    }
  };
}

/**
 * Render a thrown value to stderr in the unified CLI format.
 *
 * `debug` flag mirrors commander's `--debug` so a single chain of
 * `try`/`catch` can decide whether to include the stack trace.
 */
function reportError(err: unknown, debug: boolean): void {
  // Wrap all output in redact() so a stray token in a stack message never
  // reaches the user's terminal.
  const stderr = process.stderr;
  if (err instanceof AuthError) {
    stderr.write(chalk.red("Authentication error\n"));
    stderr.write(redact(err.message) + "\n");
  } else if (err instanceof AdapterError) {
    stderr.write(chalk.red(`Adapter error (${err.provider})\n`));
    stderr.write(redact(err.message) + "\n");
  } else if (err instanceof ValidationError) {
    stderr.write(chalk.red("Validation error\n"));
    stderr.write(redact(err.message) + "\n");
    for (const issue of err.issues) {
      stderr.write(
        chalk.red(`  - ${issue.path.join(".") || "<root>"}: ${issue.message}\n`),
      );
    }
  } else if (err instanceof ConfigError) {
    stderr.write(chalk.red("Config error\n"));
    stderr.write(redact(err.message) + "\n");
  } else if (err instanceof RangeError) {
    stderr.write(chalk.red("Invalid argument\n"));
    stderr.write(redact(err.message) + "\n");
  } else if (err instanceof Error) {
    stderr.write(chalk.red("Error\n"));
    stderr.write(redact(err.message) + "\n");
  } else {
    stderr.write(chalk.red("Unknown error: " + String(err) + "\n"));
  }
  if (debug && err instanceof Error && err.stack) {
    stderr.write(chalk.dim("\n" + redact(err.stack) + "\n"));
  }
}

/**
 * Main entry — parse argv, dispatch, and translate failures into exit codes.
 *
 * commander does its own argv mutation, so we hand it `process.argv` directly.
 * Any failure thrown by the action handlers is funneled through
 * {@link reportError} and {@link exitCodeFor} so the exit semantics are
 * documented in one place.
 */
async function main(): Promise<void> {
  const program = buildProgram();
  // `--debug` is a triage-specific flag, but the entry point needs to know
  // about it to decide whether to print stack traces from the central
  // handler. We sniff argv here rather than threading it back from the
  // command action.
  const debug = process.argv.includes("--debug");
  try {
    await program.parseAsync(process.argv);
  } catch (err: unknown) {
    reportError(err, debug);
    process.exit(exitCodeFor(err));
  }
}

main().catch((err: unknown) => {
  // Last-resort handler: only reached if `main` itself rejects before
  // commander wires up its own error handling. Should never fire in practice.
  process.stderr.write(`crashscope: fatal: ${String(err)}\n`);
  process.exit(1);
});
