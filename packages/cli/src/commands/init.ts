import { access } from "node:fs/promises";
import {
  confirm,
  input,
  password,
  select,
  checkbox,
} from "@inquirer/prompts";
import chalk from "chalk";
import {
  crashscopeConfigSchema,
  type BugsnagCredentials,
  type CrashscopeConfig,
  type ErrorProvider,
  type HoneybadgerCredentials,
  type OutputChannel,
  type PosthogCredentials,
  type RollbarCredentials,
  type SentryCredentials,
  type SessionProvider,
} from "@crashscope/core";
import { detectAnthropicAuth } from "../auth/detect.js";
import {
  validateAnthropic,
  validateBugsnag,
  validateHoneybadger,
  validatePostHog,
  validateRollbar,
  validateSentry,
  type ValidationResult,
} from "../auth/validate.js";
import { getConfigPath } from "../config/paths.js";
import { saveConfig } from "../config/save.js";

/**
 * Top-level entry for `crashscope init`.
 *
 * Walks the user through provider/output selection, collects credentials,
 * runs auth detection for Anthropic, then writes a chmod-600 config file.
 *
 * The function intentionally does not catch its own errors — that responsibility
 * lives in the entry point's central handler so every command shares the same
 * exit-code mapping (auth failures → 3, validation → 1, etc.).
 */
export async function runInit(options: {
  configPath?: string;
}): Promise<void> {
  const path = options.configPath ?? getConfigPath();

  // 1. Confirm overwrite before clobbering an existing file. Idempotency is a
  //    UX requirement: a user re-running `crashscope init` must never lose
  //    their previous tokens silently.
  if (await fileExists(path)) {
    const overwrite = await confirm({
      message: `A crashscope config already exists at ${path}. Overwrite it?`,
      default: false,
    });
    if (!overwrite) {
      process.stdout.write(chalk.yellow("Aborted — no changes written.\n"));
      return;
    }
  }

  process.stdout.write(
    chalk.bold("\ncrashscope init\n") +
      chalk.dim("Configure providers and output channels.\n\n"),
  );

  // 2. Pick the error provider and collect credentials. Each branch produces a
  //    well-typed slice of the `credentials` record so the final `safeParse`
  //    has nothing to repair.
  const errorProvider = (await select({
    message: "Error tracker provider:",
    choices: [
      { name: "Sentry", value: "sentry" },
      { name: "Rollbar", value: "rollbar" },
      { name: "Bugsnag", value: "bugsnag" },
      { name: "Honeybadger", value: "honeybadger" },
    ] as const,
    default: "sentry",
  })) as ErrorProvider;
  const errorCreds = await promptValidatedErrorCredentials(errorProvider);

  // 3. Pick the session provider.
  const sessionProvider = (await select({
    message: "Session replay provider:",
    choices: [
      { name: "PostHog", value: "posthog" },
      { name: "LogRocket", value: "logrocket" },
    ] as const,
    default: "posthog",
  })) as SessionProvider;
  const sessionCreds = await promptValidatedSessionCredentials(sessionProvider);

  // 4. Outputs. Default keeps the terminal active so first runs don't appear
  //    silent on a misconfigured webhook.
  const outputs = (await checkbox({
    message: "Where should crashscope deliver reports?",
    choices: [
      { name: "Terminal (stdout)", value: "terminal", checked: true },
      { name: "Slack (webhook)", value: "slack" },
      { name: "JSON (stdout)", value: "json" },
    ] as const,
    required: true,
  })) as OutputChannel[];

  let slackWebhook: string | undefined;
  if (outputs.includes("slack")) {
    slackWebhook = await input({
      message: "Slack incoming webhook URL:",
      validate: (v: string) =>
        /^https:\/\/hooks\.slack\.com\//.test(v.trim())
          ? true
          : "Enter a Slack incoming webhook URL (https://hooks.slack.com/...).",
    });
  }

  // 5. Anthropic key (optional). When the user skips it we detect Claude Code
  //    auth in step 6 so the user has a definite answer either way.
  const anthropicKey = await input({
    message:
      "Anthropic API key (optional — leave blank to use Claude Code subscription):",
    default: "",
  });
  const anthropicTrimmed = anthropicKey.trim();

  // 6. Assemble + validate.
  const draftConfig: CrashscopeConfig = {
    errorProvider,
    sessionProvider,
    outputs,
    credentials: {
      [errorProvider]: errorCreds,
      [sessionProvider]: sessionCreds,
      ...(slackWebhook ? { slack: { webhookUrl: slackWebhook } } : {}),
    },
    ...(anthropicTrimmed.length > 0
      ? { anthropic: { apiKey: anthropicTrimmed } }
      : {}),
  } as CrashscopeConfig;

  const parsed = crashscopeConfigSchema.safeParse(draftConfig);
  if (!parsed.success) {
    process.stdout.write(chalk.red("\nConfig failed validation:\n"));
    for (const issue of parsed.error.issues) {
      process.stdout.write(
        chalk.red(`  - ${issue.path.join(".")}: ${issue.message}\n`),
      );
    }
    process.exitCode = 1;
    return;
  }

  // 7. Auth check. Pass `draftConfig.anthropic` so the detection step honours
  //    whatever the user just entered (or didn't). When the user supplied an
  //    Anthropic API key inline we *also* hit `/v1/models` so an obviously
  //    bad key is caught here instead of on the first triage run.
  let anthropicAuthOk = true;
  const detection = await detectAnthropicAuth(parsed.data.anthropic);
  if (detection.ok) {
    process.stdout.write(chalk.green(`\n  ✓ ${detection.label}\n`));
    if (
      detection.resolution.mode === "api-key" &&
      parsed.data.anthropic?.apiKey === detection.resolution.apiKey
    ) {
      const result = await validateAnthropic(detection.resolution.apiKey);
      reportProbe(result, "Anthropic");
      if (!result.ok && !result.network) anthropicAuthOk = false;
    }
  } else {
    anthropicAuthOk = false;
    process.stdout.write(chalk.red(`\n  ✗ Anthropic auth failed:\n`));
    process.stdout.write(chalk.red(`    ${detection.message}\n`));
    for (const hint of detection.hints) {
      process.stdout.write(chalk.dim(`    • ${hint}\n`));
    }
  }

  if (!anthropicAuthOk) {
    const proceed = await confirm({
      message: "Anthropic auth check failed. Save the config anyway?",
      default: false,
    });
    if (!proceed) {
      process.stdout.write(chalk.yellow("Aborted — no changes written.\n"));
      return;
    }
    process.stdout.write(
      chalk.yellow(
        "\nSaving config — fix Anthropic auth before running `crashscope triage`.\n",
      ),
    );
  }

  // 8. Persist.
  const written = await saveConfig(parsed.data, options.configPath);
  process.stdout.write(
    chalk.green(`\n  ✓ Config written to ${written} (mode 0600)\n`) +
      chalk.dim("\nNext: run `crashscope triage` to fetch and analyse errors.\n"),
  );
}

/**
 * Render the outcome of a `validate*` probe inline.
 *
 * Three states map to three colours so the user knows whether to retry,
 * proceed, or fix something — without having to read the surrounding prose:
 *   - success         → green checkmark.
 *   - upstream reject → red cross (the wizard will offer to re-prompt).
 *   - network failure → yellow warning (the wizard proceeds with a caveat).
 */
function reportProbe(result: ValidationResult, label: string): void {
  if (result.ok) {
    process.stdout.write(chalk.green(`  ✓ ${label} credential verified.\n`));
    return;
  }
  if (result.network === true) {
    process.stdout.write(
      chalk.yellow(`  ⚠ ${label} probe could not reach the API: ${result.message}\n`) +
        chalk.dim(`    Proceeding without live verification.\n`),
    );
    return;
  }
  process.stdout.write(chalk.red(`  ✗ ${label} rejected: ${result.message}\n`));
}

/**
 * Loop on credential entry until live validation passes, the upstream is
 * unreachable, or the user opts out.
 *
 * Returning the *last* credentials the user typed gives them a chance to fix
 * an obvious typo without retyping the entire form on every miss.
 *
 * `C` is unconstrained so the helper works for credential shapes with
 * optional fields (which would clash with `Record<string, string>`).
 */
async function promptUntilValid<C>(
  collect: () => Promise<C>,
  validate: (creds: C) => Promise<ValidationResult>,
  label: string,
): Promise<C> {
  // Loop until the user signals they're done (success, network failure they
  // accept, or an auth failure they want to skip past).
  for (;;) {
    const creds = await collect();
    const result = await validate(creds);
    reportProbe(result, label);
    if (result.ok) return creds;
    if (result.network === true) {
      // Surface the warning above; user can proceed without retrying.
      return creds;
    }
    const retry = await confirm({
      message: `Re-enter ${label} credentials?`,
      default: true,
    });
    if (!retry) return creds;
  }
}

/**
 * Union of every error-provider credential block we may collect.
 *
 * The wizard hands these straight to `credentials[errorProvider] = …` and the
 * final `crashscopeConfigSchema.safeParse` enforces the per-provider rules.
 */
type ErrorCredentials =
  | SentryCredentials
  | RollbarCredentials
  | BugsnagCredentials
  | HoneybadgerCredentials;

/**
 * Session-provider counterpart of {@link ErrorCredentials}.
 *
 * LogRocket's credential shape is the same `Record<string, string>` the
 * legacy `promptSessionCredentials` returned, so we keep it explicit here.
 */
type SessionCredentials = PosthogCredentials | { apiKey: string; appSlug: string };

/**
 * Variant of the credential prompts that runs the matching provider probe
 * and re-prompts on auth failure.
 */
async function promptValidatedErrorCredentials(
  provider: ErrorProvider,
): Promise<ErrorCredentials> {
  switch (provider) {
    case "sentry":
      return promptUntilValid<SentryCredentials>(
        collectSentry,
        validateSentry,
        "Sentry",
      );
    case "rollbar":
      return promptUntilValid<RollbarCredentials>(
        collectRollbar,
        validateRollbar,
        "Rollbar",
      );
    case "bugsnag":
      return promptUntilValid<BugsnagCredentials>(
        collectBugsnag,
        validateBugsnag,
        "Bugsnag",
      );
    case "honeybadger":
      return promptUntilValid<HoneybadgerCredentials>(
        collectHoneybadger,
        validateHoneybadger,
        "Honeybadger",
      );
  }
}

/**
 * Session-provider counterpart to {@link promptValidatedErrorCredentials}.
 *
 * LogRocket's adapter is being rewritten by another agent, so we skip the
 * live probe and rely on the basic non-empty validators.
 */
async function promptValidatedSessionCredentials(
  provider: SessionProvider,
): Promise<SessionCredentials> {
  switch (provider) {
    case "posthog":
      return promptUntilValid<PosthogCredentials>(
        collectPostHog,
        validatePostHog,
        "PostHog",
      );
    case "logrocket":
      return collectLogRocket();
  }
}

/** Helper: does `path` exist on disk? */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validator passed to `@inquirer/prompts` for non-empty trimmed strings.
 *
 * Inquirer's validators may return `true`, an error string, or a `Promise` of
 * either. We surface a one-line error so the prompt redraws inline.
 */
function required(label: string): (value: string) => string | true {
  return (value: string) =>
    value.trim().length > 0 ? true : `${label} is required.`;
}

// ---- Per-provider credential collection ------------------------------------
//
// Each `collect*` function does one pass through the wizard's questions and
// returns a typed credentials object. Live validation happens in
// {@link promptUntilValid}; keeping collection separate lets us re-prompt
// without restructuring the question flow.

async function collectSentry(): Promise<SentryCredentials> {
  const token = await password({
    message: "Sentry auth token:",
    mask: "*",
    validate: required("Token"),
  });
  const org = await input({
    message: "Sentry organization slug:",
    validate: required("Organization"),
  });
  const project = await input({
    message: "Sentry project slug:",
    validate: required("Project"),
  });
  return { token: token.trim(), org: org.trim(), project: project.trim() };
}

async function collectRollbar(): Promise<RollbarCredentials> {
  const readToken = await password({
    message: "Rollbar read access token:",
    mask: "*",
    validate: required("Read token"),
  });
  const project = await input({
    message: "Rollbar project slug (optional, blank to skip):",
  });
  const trimmedProject = project.trim();
  return trimmedProject.length > 0
    ? { readToken: readToken.trim(), project: trimmedProject }
    : { readToken: readToken.trim() };
}

async function collectBugsnag(): Promise<BugsnagCredentials> {
  const token = await password({
    message: "Bugsnag personal auth token:",
    mask: "*",
    validate: required("Token"),
  });
  const organizationId = await input({
    message: "Bugsnag organization id:",
    validate: required("Organization id"),
  });
  const projectId = await input({
    message: "Bugsnag project id:",
    validate: required("Project id"),
  });
  return {
    token: token.trim(),
    organizationId: organizationId.trim(),
    projectId: projectId.trim(),
  };
}

async function collectHoneybadger(): Promise<HoneybadgerCredentials> {
  const token = await password({
    message: "Honeybadger auth token:",
    mask: "*",
    validate: required("Token"),
  });
  const projectId = await input({
    message: "Honeybadger project id:",
    validate: required("Project id"),
  });
  return { token: token.trim(), projectId: projectId.trim() };
}

async function collectPostHog(): Promise<PosthogCredentials> {
  const apiKey = await password({
    message: "PostHog personal API key:",
    mask: "*",
    validate: required("API key"),
  });
  const projectId = await input({
    message: "PostHog project id:",
    validate: required("Project id"),
  });
  const host = await input({
    message: "PostHog host (blank for app.posthog.com):",
    default: "",
  });
  const hostTrimmed = host.trim();
  return hostTrimmed.length > 0
    ? { apiKey: apiKey.trim(), projectId: projectId.trim(), host: hostTrimmed }
    : { apiKey: apiKey.trim(), projectId: projectId.trim() };
}

async function collectLogRocket(): Promise<{ apiKey: string; appSlug: string }> {
  const apiKey = await password({
    message: "LogRocket API key:",
    mask: "*",
    validate: required("API key"),
  });
  const appSlug = await input({
    message: "LogRocket app slug:",
    validate: required("App slug"),
  });
  return { apiKey: apiKey.trim(), appSlug: appSlug.trim() };
}
