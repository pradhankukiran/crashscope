import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import chalk from "chalk";
import { ConfigError, type CrashscopeConfig } from "@crashscope/core";
import { loadConfig } from "../config/load.js";
import { getConfigPath } from "../config/paths.js";
import { maskPreservingTail } from "../util/redact.js";

/** Sub-action selected on the command line: `crashscope config <action>`. */
export type ConfigAction = "show" | "path" | "edit";

/**
 * Entry point for `crashscope config`.
 *
 * `path` is a thin wrapper around {@link getConfigPath}; `show` reads the
 * file and masks credentials; `edit` defers to `$EDITOR`. Each sub-action is
 * a separate helper so unit tests can call them in isolation.
 */
export async function runConfig(
  action: ConfigAction,
  options: { configPath?: string } = {},
): Promise<void> {
  switch (action) {
    case "path":
      return showPath(options.configPath);
    case "show":
      return showConfig(options.configPath);
    case "edit":
      return editConfig(options.configPath);
  }
}

/** Print the resolved config path to stdout (one line, newline-terminated). */
function showPath(override: string | undefined): void {
  const path = override ?? getConfigPath();
  process.stdout.write(path + "\n");
}

/**
 * Print a masked rendition of the current config.
 *
 * All credential strings are passed through {@link maskPreservingTail} so the
 * output is safe to paste into a bug report. The structure of the JSON is
 * preserved so the user can still see which fields are populated.
 */
async function showConfig(override: string | undefined): Promise<void> {
  const config = await loadConfig(override);
  const masked = maskConfig(config);
  process.stdout.write(JSON.stringify(masked, null, 2) + "\n");
}

/**
 * Open the config file in `$EDITOR`, falling back to printing the path.
 *
 * We deliberately don't import a heavy "edit-and-wait" helper — `$EDITOR`
 * conventions are well-understood and a spawned child with `stdio: "inherit"`
 * gives the user a native experience.
 */
async function editConfig(override: string | undefined): Promise<void> {
  const path = override ?? getConfigPath();
  try {
    await access(path);
  } catch {
    throw new ConfigError(
      `Config file not found at ${path}. Run \`crashscope init\` first.`,
    );
  }
  const editor =
    process.env["VISUAL"]?.trim() ?? process.env["EDITOR"]?.trim() ?? "";
  if (editor.length === 0) {
    process.stdout.write(
      chalk.yellow(
        "No $EDITOR set. Open the file manually:\n",
      ) + `  ${path}\n`,
    );
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(editor, [path], { stdio: "inherit" });
    child.on("exit", (code) => {
      if (code === 0 || code === null) resolve();
      else reject(new ConfigError(`Editor "${editor}" exited with code ${code}.`));
    });
    child.on("error", (err) =>
      reject(new ConfigError(`Failed to launch editor "${editor}": ${err.message}`)),
    );
  });
}

/**
 * Return a deep copy of `config` with every credential field masked.
 *
 * Implemented as a structural traversal (rather than a generic walker) so
 * adding a new credential block forces an update here — easier to spot in
 * code review than a "did we forget a field?" runtime bug.
 */
function maskConfig(config: CrashscopeConfig): unknown {
  const masked: Record<string, unknown> = {
    errorProvider: config.errorProvider,
    sessionProvider: config.sessionProvider,
    outputs: [...config.outputs],
    credentials: {},
  };
  const c = config.credentials;
  const credsOut: Record<string, unknown> = {};
  if (c.sentry) {
    credsOut["sentry"] = {
      token: maskPreservingTail(c.sentry.token),
      org: c.sentry.org,
      project: c.sentry.project,
    };
  }
  if (c.rollbar) {
    credsOut["rollbar"] = {
      readToken: maskPreservingTail(c.rollbar.readToken),
      ...(c.rollbar.project ? { project: c.rollbar.project } : {}),
    };
  }
  if (c.bugsnag) {
    credsOut["bugsnag"] = {
      token: maskPreservingTail(c.bugsnag.token),
      organizationId: c.bugsnag.organizationId,
      projectId: c.bugsnag.projectId,
    };
  }
  if (c.honeybadger) {
    credsOut["honeybadger"] = {
      token: maskPreservingTail(c.honeybadger.token),
      projectId: c.honeybadger.projectId,
    };
  }
  if (c.posthog) {
    credsOut["posthog"] = {
      apiKey: maskPreservingTail(c.posthog.apiKey),
      projectId: c.posthog.projectId,
      ...(c.posthog.host ? { host: c.posthog.host } : {}),
    };
  }
  if (c.logrocket) {
    credsOut["logrocket"] = {
      apiKey: maskPreservingTail(c.logrocket.apiKey),
      appSlug: c.logrocket.appSlug,
    };
  }
  if (c.slack) {
    credsOut["slack"] = {
      ...(c.slack.webhookUrl
        ? { webhookUrl: maskWebhook(c.slack.webhookUrl) }
        : {}),
      ...(c.slack.botToken
        ? { botToken: maskPreservingTail(c.slack.botToken) }
        : {}),
      ...(c.slack.signingSecret
        ? { signingSecret: maskPreservingTail(c.slack.signingSecret) }
        : {}),
    };
  }
  masked["credentials"] = credsOut;
  if (config.anthropic?.apiKey) {
    masked["anthropic"] = { apiKey: maskPreservingTail(config.anthropic.apiKey) };
  }
  return masked;
}

/**
 * Mask the secret-bearing path portion of a Slack incoming webhook URL while
 * keeping the host visible. Useful for the `show` command output where the
 * user wants to verify their config without exposing the webhook.
 */
function maskWebhook(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/services/<REDACTED>`;
  } catch {
    return maskPreservingTail(url);
  }
}
