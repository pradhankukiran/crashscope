import { z } from "zod";
import { errorProviderSchema } from "./error.js";
import { sessionProviderSchema } from "./session.js";

/**
 * Where a triage report should be delivered.
 *
 * - `terminal`: pretty-printed to stdout (default for CLI runs).
 * - `slack`: posted to a Slack workspace via webhook or bot token.
 * - `json`: machine-readable artifact (e.g. for CI).
 */
export const outputChannelSchema = z.enum(["terminal", "slack", "json"]);
export type OutputChannel = z.infer<typeof outputChannelSchema>;

// --- Per-provider credential shapes ------------------------------------------

export const sentryCredentialsSchema = z.object({
  token: z.string().min(1),
  org: z.string().min(1),
  project: z.string().min(1),
});
export type SentryCredentials = z.infer<typeof sentryCredentialsSchema>;

export const rollbarCredentialsSchema = z.object({
  readToken: z.string().min(1),
  project: z.string().min(1).optional(),
});
export type RollbarCredentials = z.infer<typeof rollbarCredentialsSchema>;

export const bugsnagCredentialsSchema = z.object({
  token: z.string().min(1),
  organizationId: z.string().min(1),
  projectId: z.string().min(1),
});
export type BugsnagCredentials = z.infer<typeof bugsnagCredentialsSchema>;

export const honeybadgerCredentialsSchema = z.object({
  token: z.string().min(1),
  projectId: z.string().min(1),
});
export type HoneybadgerCredentials = z.infer<
  typeof honeybadgerCredentialsSchema
>;

export const posthogCredentialsSchema = z.object({
  apiKey: z.string().min(1),
  projectId: z.string().min(1),
  host: z.string().url().optional(),
});
export type PosthogCredentials = z.infer<typeof posthogCredentialsSchema>;

export const logrocketCredentialsSchema = z.object({
  apiKey: z.string().min(1),
  appSlug: z.string().min(1),
});
export type LogRocketCredentials = z.infer<typeof logrocketCredentialsSchema>;

/**
 * Slack delivery credentials. At least one of webhookUrl or botToken should be
 * provided when "slack" is in `outputs`; validation of that cross-field rule
 * lives in {@link crashscopeConfigSchema}.
 */
export const slackCredentialsSchema = z.object({
  webhookUrl: z.string().url().optional(),
  botToken: z.string().min(1).optional(),
  signingSecret: z.string().min(1).optional(),
});
export type SlackCredentials = z.infer<typeof slackCredentialsSchema>;

export const credentialsSchema = z.object({
  sentry: sentryCredentialsSchema.optional(),
  rollbar: rollbarCredentialsSchema.optional(),
  bugsnag: bugsnagCredentialsSchema.optional(),
  honeybadger: honeybadgerCredentialsSchema.optional(),
  posthog: posthogCredentialsSchema.optional(),
  logrocket: logrocketCredentialsSchema.optional(),
  slack: slackCredentialsSchema.optional(),
});
export type Credentials = z.infer<typeof credentialsSchema>;

/**
 * Optional Anthropic API configuration.
 *
 * If `apiKey` is absent, crashscope falls back to the user's Claude Code
 * subscription auth (i.e. the SDK auth context this runs in).
 */
export const anthropicConfigSchema = z.object({
  apiKey: z.string().min(1).optional(),
});
export type AnthropicConfig = z.infer<typeof anthropicConfigSchema>;

/**
 * Top-level crashscope configuration.
 *
 * Cross-field invariants:
 * - `credentials[errorProvider]` must be set.
 * - `credentials[sessionProvider]` must be set.
 * - If "slack" is in `outputs`, `credentials.slack` must provide at least one
 *   of webhookUrl or botToken.
 */
export const crashscopeConfigSchema = z
  .object({
    errorProvider: errorProviderSchema,
    sessionProvider: sessionProviderSchema,
    outputs: z.array(outputChannelSchema).min(1),
    credentials: credentialsSchema,
    anthropic: anthropicConfigSchema.optional(),
  })
  .superRefine((cfg, ctx) => {
    if (!cfg.credentials[cfg.errorProvider]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["credentials", cfg.errorProvider],
        message: `Missing credentials for error provider "${cfg.errorProvider}".`,
      });
    }
    if (!cfg.credentials[cfg.sessionProvider]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["credentials", cfg.sessionProvider],
        message: `Missing credentials for session provider "${cfg.sessionProvider}".`,
      });
    }
    if (cfg.outputs.includes("slack")) {
      const slack = cfg.credentials.slack;
      if (!slack || (!slack.webhookUrl && !slack.botToken)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["credentials", "slack"],
          message:
            'Slack output requires credentials.slack.webhookUrl or credentials.slack.botToken.',
        });
      }
    }
  });
export type CrashscopeConfig = z.infer<typeof crashscopeConfigSchema>;
