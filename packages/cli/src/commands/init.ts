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
  type CrashscopeConfig,
  type ErrorProvider,
  type OutputChannel,
  type SessionProvider,
} from "@crashscope/core";
import { detectAnthropicAuth } from "../auth/detect.js";
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
  const errorCreds = await promptErrorCredentials(errorProvider);

  // 3. Pick the session provider.
  const sessionProvider = (await select({
    message: "Session replay provider:",
    choices: [
      { name: "PostHog", value: "posthog" },
      { name: "LogRocket", value: "logrocket" },
    ] as const,
    default: "posthog",
  })) as SessionProvider;
  const sessionCreds = await promptSessionCredentials(sessionProvider);

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
  //    whatever the user just entered (or didn't).
  const detection = await detectAnthropicAuth(parsed.data.anthropic);
  if (detection.ok) {
    process.stdout.write(chalk.green(`\n  ✓ ${detection.label}\n`));
  } else {
    process.stdout.write(chalk.red(`\n  ✗ Anthropic auth failed:\n`));
    process.stdout.write(chalk.red(`    ${detection.message}\n`));
    for (const hint of detection.hints) {
      process.stdout.write(chalk.dim(`    • ${hint}\n`));
    }
    process.stdout.write(
      chalk.yellow(
        "\nSaving config anyway — fix Anthropic auth before running `crashscope triage`.\n",
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

/**
 * Branch on the chosen error provider and prompt for that provider's required
 * fields, returning the credentials object shaped for the config.
 *
 * Tokens are read via `password()` so they are echo-masked on the terminal
 * and never appear in shell scrollback as plain text.
 */
async function promptErrorCredentials(
  provider: ErrorProvider,
): Promise<Record<string, string>> {
  switch (provider) {
    case "sentry": {
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
    case "rollbar": {
      const readToken = await password({
        message: "Rollbar read access token:",
        mask: "*",
        validate: required("Read token"),
      });
      const project = await input({
        message: "Rollbar project slug (optional, blank to skip):",
      });
      const out: Record<string, string> = { readToken: readToken.trim() };
      const trimmedProject = project.trim();
      if (trimmedProject.length > 0) out["project"] = trimmedProject;
      return out;
    }
    case "bugsnag": {
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
    case "honeybadger": {
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
  }
}

/**
 * Branch on the chosen session provider and prompt for credentials.
 *
 * See {@link promptErrorCredentials} for the rationale on `password()` use
 * and the `required()` validator pattern.
 */
async function promptSessionCredentials(
  provider: SessionProvider,
): Promise<Record<string, string>> {
  switch (provider) {
    case "posthog": {
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
      const out: Record<string, string> = {
        apiKey: apiKey.trim(),
        projectId: projectId.trim(),
      };
      const hostTrimmed = host.trim();
      if (hostTrimmed.length > 0) out["host"] = hostTrimmed;
      return out;
    }
    case "logrocket": {
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
  }
}
