"use client";

/**
 * DemoForm — the in-page triage form that powers the public landing-page
 * demo, rebuilt on top of shadcn/ui + react-hook-form + zod.
 *
 * Behaviour preserved from the original implementation:
 *  - State persists to `localStorage` under `crashscope-demo-config`.
 *  - On submit, POSTs to `/api/triage` (same-origin, no Authorization header).
 *  - While running, the submit button shows the elapsed time and the parent
 *    receives run-state changes via `onRunStateChange`.
 *  - On 200, the parsed report is handed to `onResult`.
 *  - On any error, the message goes to `onError` and is also shown inline.
 *
 * Credentials live in the browser only. The disclaimer at the bottom makes
 * that explicit.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import {
  AlertCircle,
  Eye,
  EyeOff,
  Loader2,
  Lock,
} from "lucide-react";
import type { TriageReport } from "@crashscope/core";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// ----- Types ---------------------------------------------------------------

const ERROR_PROVIDERS = [
  "sentry",
  "rollbar",
  "bugsnag",
  "honeybadger",
] as const;
const SESSION_PROVIDERS = ["posthog", "logrocket"] as const;
const SINCE_VALUES = ["1h", "6h", "24h", "7d", "14d", "30d"] as const;

type ErrorProvider = (typeof ERROR_PROVIDERS)[number];
type SessionProvider = (typeof SESSION_PROVIDERS)[number];
type SinceWindow = (typeof SINCE_VALUES)[number];

/**
 * Zod schema for the demo form. We validate the entire snapshot — fields for
 * inactive providers are kept around (so we can restore them after toggling)
 * but only the active provider's group must be non-empty.
 *
 * `superRefine` carries the conditional-required logic so the field-level
 * messages still attach to the right input.
 */
const formSchema = z
  .object({
    anthropicApiKey: z.string().min(1, "Anthropic API key is required."),
    errorProvider: z.enum(ERROR_PROVIDERS),
    sessionProvider: z.enum(SESSION_PROVIDERS),
    sentry: z.object({
      token: z.string(),
      org: z.string(),
      project: z.string(),
    }),
    rollbar: z.object({
      readToken: z.string(),
      project: z.string(),
    }),
    bugsnag: z.object({
      token: z.string(),
      organizationId: z.string(),
      projectId: z.string(),
    }),
    honeybadger: z.object({
      token: z.string(),
      projectId: z.string(),
    }),
    posthog: z.object({
      apiKey: z.string(),
      projectId: z.string(),
      host: z.string(),
    }),
    logrocket: z.object({
      apiKey: z.string(),
      appSlug: z.string(),
    }),
    since: z.enum(SINCE_VALUES),
    limit: z.coerce.number().int().min(1).max(25),
  })
  .superRefine((data, ctx) => {
    switch (data.errorProvider) {
      case "sentry":
        if (!data.sentry.token)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["sentry", "token"],
            message: "Required.",
          });
        if (!data.sentry.org)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["sentry", "org"],
            message: "Required.",
          });
        if (!data.sentry.project)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["sentry", "project"],
            message: "Required.",
          });
        break;
      case "rollbar":
        if (!data.rollbar.readToken)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["rollbar", "readToken"],
            message: "Required.",
          });
        break;
      case "bugsnag":
        if (!data.bugsnag.token)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["bugsnag", "token"],
            message: "Required.",
          });
        if (!data.bugsnag.organizationId)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["bugsnag", "organizationId"],
            message: "Required.",
          });
        if (!data.bugsnag.projectId)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["bugsnag", "projectId"],
            message: "Required.",
          });
        break;
      case "honeybadger":
        if (!data.honeybadger.token)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["honeybadger", "token"],
            message: "Required.",
          });
        if (!data.honeybadger.projectId)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["honeybadger", "projectId"],
            message: "Required.",
          });
        break;
    }
    switch (data.sessionProvider) {
      case "posthog":
        if (!data.posthog.apiKey)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["posthog", "apiKey"],
            message: "Required.",
          });
        if (!data.posthog.projectId)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["posthog", "projectId"],
            message: "Required.",
          });
        break;
      case "logrocket":
        if (!data.logrocket.apiKey)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["logrocket", "apiKey"],
            message: "Required.",
          });
        if (!data.logrocket.appSlug)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["logrocket", "appSlug"],
            message: "Required.",
          });
        break;
    }
  });

type FormValues = z.infer<typeof formSchema>;

export interface DemoFormProps {
  onResult: (report: TriageReport) => void;
  onError: (message: string) => void;
  onRunStateChange?: (state: { running: boolean; elapsedMs: number }) => void;
}

// ----- Defaults + persistence ---------------------------------------------

const STORAGE_KEY = "crashscope-demo-config";

const DEFAULT_VALUES: FormValues = {
  anthropicApiKey: "",
  errorProvider: "sentry",
  sessionProvider: "posthog",
  sentry: { token: "", org: "", project: "" },
  rollbar: { readToken: "", project: "" },
  bugsnag: { token: "", organizationId: "", projectId: "" },
  honeybadger: { token: "", projectId: "" },
  posthog: {
    apiKey: "",
    projectId: "",
    host: "https://us.i.posthog.com",
  },
  logrocket: { apiKey: "", appSlug: "" },
  since: "24h",
  limit: 5,
};

function isErrorProvider(v: unknown): v is ErrorProvider {
  return typeof v === "string" && (ERROR_PROVIDERS as readonly string[]).includes(v);
}
function isSessionProvider(v: unknown): v is SessionProvider {
  return typeof v === "string" && (SESSION_PROVIDERS as readonly string[]).includes(v);
}
function isSince(v: unknown): v is SinceWindow {
  return typeof v === "string" && (SINCE_VALUES as readonly string[]).includes(v);
}

/**
 * Merge a (potentially partial) stored snapshot back into defaults. Older
 * deploys may have written a partial shape; we only keep keys that match the
 * current schema.
 */
function mergeStored(stored: unknown): FormValues {
  if (!stored || typeof stored !== "object") return DEFAULT_VALUES;
  const s = stored as Record<string, unknown>;
  return {
    anthropicApiKey:
      typeof s["anthropicApiKey"] === "string"
        ? s["anthropicApiKey"]
        : DEFAULT_VALUES.anthropicApiKey,
    errorProvider: isErrorProvider(s["errorProvider"])
      ? s["errorProvider"]
      : DEFAULT_VALUES.errorProvider,
    sessionProvider: isSessionProvider(s["sessionProvider"])
      ? s["sessionProvider"]
      : DEFAULT_VALUES.sessionProvider,
    sentry: {
      ...DEFAULT_VALUES.sentry,
      ...((s["sentry"] as Partial<FormValues["sentry"]> | undefined) ?? {}),
    },
    rollbar: {
      ...DEFAULT_VALUES.rollbar,
      ...((s["rollbar"] as Partial<FormValues["rollbar"]> | undefined) ?? {}),
    },
    bugsnag: {
      ...DEFAULT_VALUES.bugsnag,
      ...((s["bugsnag"] as Partial<FormValues["bugsnag"]> | undefined) ?? {}),
    },
    honeybadger: {
      ...DEFAULT_VALUES.honeybadger,
      ...((s["honeybadger"] as Partial<FormValues["honeybadger"]> | undefined) ??
        {}),
    },
    posthog: {
      ...DEFAULT_VALUES.posthog,
      ...((s["posthog"] as Partial<FormValues["posthog"]> | undefined) ?? {}),
    },
    logrocket: {
      ...DEFAULT_VALUES.logrocket,
      ...((s["logrocket"] as Partial<FormValues["logrocket"]> | undefined) ??
        {}),
    },
    since: isSince(s["since"]) ? s["since"] : DEFAULT_VALUES.since,
    limit:
      typeof s["limit"] === "number" && s["limit"] >= 1 && s["limit"] <= 25
        ? Math.floor(s["limit"])
        : DEFAULT_VALUES.limit,
  };
}

// ----- Component ----------------------------------------------------------

export function DemoForm({
  onResult,
  onError,
  onRunStateChange,
}: DemoFormProps): JSX.Element {
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: DEFAULT_VALUES,
    mode: "onSubmit",
  });

  const [hydrated, setHydrated] = useState(false);
  const [running, setRunning] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const [showAnthropicKey, setShowAnthropicKey] = useState(false);
  const tickRef = useRef<number | null>(null);

  // ----- Hydrate from localStorage once. -----------------------------------

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) form.reset(mergeStored(JSON.parse(raw)));
    } catch {
      // Corrupt storage just falls back to defaults.
    }
    setHydrated(true);
    // We deliberately run this once; the form instance is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist on every value change AFTER hydration so we don't blow away
  // stored state with the default snapshot on first render.
  useEffect(() => {
    if (!hydrated) return;
    const subscription = form.watch((value) => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      } catch {
        // Quota or privacy mode: ignore.
      }
    });
    return () => subscription.unsubscribe();
  }, [form, hydrated]);

  // Surface run state to the parent.
  useEffect(() => {
    onRunStateChange?.({ running, elapsedMs });
  }, [onRunStateChange, running, elapsedMs]);

  // Elapsed-time ticker while running.
  useEffect(() => {
    if (!running) {
      if (tickRef.current !== null) {
        window.clearInterval(tickRef.current);
        tickRef.current = null;
      }
      return;
    }
    const start = Date.now();
    setElapsedMs(0);
    tickRef.current = window.setInterval(() => {
      setElapsedMs(Date.now() - start);
    }, 250);
    return () => {
      if (tickRef.current !== null) {
        window.clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };
  }, [running]);

  const errorProvider = form.watch("errorProvider");
  const sessionProvider = form.watch("sessionProvider");

  // ----- Submit -----------------------------------------------------------

  const onSubmit = useCallback(
    async (values: FormValues): Promise<void> => {
      setFormError(null);

      const credentials: Record<string, unknown> = {};
      switch (values.errorProvider) {
        case "sentry":
          credentials["sentry"] = values.sentry;
          break;
        case "rollbar":
          credentials["rollbar"] = values.rollbar.project.trim()
            ? values.rollbar
            : { readToken: values.rollbar.readToken };
          break;
        case "bugsnag":
          credentials["bugsnag"] = values.bugsnag;
          break;
        case "honeybadger":
          credentials["honeybadger"] = values.honeybadger;
          break;
      }
      switch (values.sessionProvider) {
        case "posthog":
          credentials["posthog"] = {
            apiKey: values.posthog.apiKey,
            projectId: values.posthog.projectId,
            ...(values.posthog.host ? { host: values.posthog.host } : {}),
          };
          break;
        case "logrocket":
          credentials["logrocket"] = values.logrocket;
          break;
      }

      const body = {
        errorProvider: values.errorProvider,
        sessionProvider: values.sessionProvider,
        credentials,
        anthropic: { apiKey: values.anthropicApiKey },
        opts: {
          since: values.since,
          limit: values.limit,
        },
      };

      setRunning(true);
      try {
        const res = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        let payload: unknown = null;
        try {
          payload = JSON.parse(text);
        } catch {
          // Non-JSON body — surface raw text below.
        }
        if (!res.ok) {
          const message =
            payload &&
            typeof payload === "object" &&
            payload !== null &&
            "message" in payload &&
            typeof (payload as { message: unknown }).message === "string"
              ? (payload as { message: string }).message
              : `Request failed with status ${res.status}.`;
          setFormError(message);
          onError(message);
          return;
        }
        onResult(payload as TriageReport);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Network error.";
        setFormError(message);
        onError(message);
      } finally {
        setRunning(false);
      }
    },
    [onError, onResult],
  );

  // ----- Render -----------------------------------------------------------

  const elapsedSeconds = useMemo(() => (elapsedMs / 1000).toFixed(1), [elapsedMs]);

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="flex flex-col gap-6"
        noValidate
      >
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          {/* AI section */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">AI</CardTitle>
              <CardDescription>Anthropic credentials.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <FormField
                control={form.control}
                name="anthropicApiKey"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Anthropic API key</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Input
                          {...field}
                          type={showAnthropicKey ? "text" : "password"}
                          autoComplete="off"
                          spellCheck={false}
                          placeholder="sk-ant-..."
                          className="pr-10 font-mono"
                        />
                        <button
                          type="button"
                          onClick={() => setShowAnthropicKey((s) => !s)}
                          className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
                          aria-label={
                            showAnthropicKey ? "Hide key" : "Show key"
                          }
                          tabIndex={-1}
                        >
                          {showAnthropicKey ? (
                            <EyeOff className="h-4 w-4" />
                          ) : (
                            <Eye className="h-4 w-4" />
                          )}
                        </button>
                      </div>
                    </FormControl>
                    <FormDescription>
                      Used once for this request. Never stored server-side.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          {/* Run options */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Run options</CardTitle>
              <CardDescription>Window and result cap.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <FormField
                control={form.control}
                name="since"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Window</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Window" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="1h">Last 1 hour</SelectItem>
                        <SelectItem value="6h">Last 6 hours</SelectItem>
                        <SelectItem value="24h">Last 24 hours</SelectItem>
                        <SelectItem value="7d">Last 7 days</SelectItem>
                        <SelectItem value="14d">Last 14 days</SelectItem>
                        <SelectItem value="30d">Last 30 days</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="limit"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Limit (1–25)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        max={25}
                        value={field.value}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          field.onChange(
                            Number.isFinite(n)
                              ? Math.min(25, Math.max(1, Math.floor(n)))
                              : field.value,
                          );
                        }}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          {/* Error provider */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Error provider</CardTitle>
              <CardDescription>Where your crashes come from.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <FormField
                control={form.control}
                name="errorProvider"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Provider</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="sentry">Sentry</SelectItem>
                        <SelectItem value="rollbar">Rollbar</SelectItem>
                        <SelectItem value="bugsnag">Bugsnag</SelectItem>
                        <SelectItem value="honeybadger">Honeybadger</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {errorProvider === "sentry" && (
                <>
                  <FormField
                    control={form.control}
                    name="sentry.token"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Token</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            type="password"
                            autoComplete="off"
                            className="font-mono"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="sentry.org"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Org</FormLabel>
                        <FormControl>
                          <Input {...field} className="font-mono" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="sentry.project"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Project</FormLabel>
                        <FormControl>
                          <Input {...field} className="font-mono" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </>
              )}

              {errorProvider === "rollbar" && (
                <>
                  <FormField
                    control={form.control}
                    name="rollbar.readToken"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Read token</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            type="password"
                            autoComplete="off"
                            className="font-mono"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="rollbar.project"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Project (optional)</FormLabel>
                        <FormControl>
                          <Input {...field} className="font-mono" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </>
              )}

              {errorProvider === "bugsnag" && (
                <>
                  <FormField
                    control={form.control}
                    name="bugsnag.token"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Token</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            type="password"
                            autoComplete="off"
                            className="font-mono"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="bugsnag.organizationId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Organization id</FormLabel>
                        <FormControl>
                          <Input {...field} className="font-mono" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="bugsnag.projectId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Project id</FormLabel>
                        <FormControl>
                          <Input {...field} className="font-mono" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </>
              )}

              {errorProvider === "honeybadger" && (
                <>
                  <FormField
                    control={form.control}
                    name="honeybadger.token"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Token</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            type="password"
                            autoComplete="off"
                            className="font-mono"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="honeybadger.projectId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Project id</FormLabel>
                        <FormControl>
                          <Input {...field} className="font-mono" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </>
              )}
            </CardContent>
          </Card>

          {/* Session provider */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Session provider</CardTitle>
              <CardDescription>
                Where the user&apos;s session replay lives.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <FormField
                control={form.control}
                name="sessionProvider"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Provider</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="posthog">PostHog</SelectItem>
                        <SelectItem value="logrocket">LogRocket</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {sessionProvider === "posthog" && (
                <>
                  <FormField
                    control={form.control}
                    name="posthog.apiKey"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>API key</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            type="password"
                            autoComplete="off"
                            className="font-mono"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="posthog.projectId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Project id</FormLabel>
                        <FormControl>
                          <Input {...field} className="font-mono" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="posthog.host"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Host</FormLabel>
                        <FormControl>
                          <Input {...field} className="font-mono" />
                        </FormControl>
                        <FormDescription>
                          EU: https://eu.i.posthog.com
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </>
              )}

              {sessionProvider === "logrocket" && (
                <>
                  <FormField
                    control={form.control}
                    name="logrocket.apiKey"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>API key</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            type="password"
                            autoComplete="off"
                            className="font-mono"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="logrocket.appSlug"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>App slug</FormLabel>
                        <FormControl>
                          <Input {...field} className="font-mono" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {formError ? (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}

        <Separator />

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Button type="submit" size="lg" disabled={running}>
            {running ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Triaging… {elapsedSeconds}s</span>
              </>
            ) : (
              <span>Run triage</span>
            )}
          </Button>
          <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Lock className="h-3.5 w-3.5" />
            <span>
              Credentials only live in your browser — they&apos;re sent
              transiently to the server for one request and never stored.
            </span>
          </p>
        </div>
      </form>
    </Form>
  );
}
