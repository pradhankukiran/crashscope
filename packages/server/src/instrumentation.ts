/**
 * Next.js boot-time instrumentation hook.
 *
 * Next calls `register()` once per process at startup (server + edge). We use
 * it to surface env-misconfiguration loudly at deploy/boot time instead of
 * waiting for the first request to fail. The actual loader is dynamically
 * imported so it never ends up in the edge bundle: the Zod schema and the
 * `ConfigError` class both pull `node:`-only code transitively, and the edge
 * runtime would refuse to start with them in scope.
 *
 * On failure we **don't** crash the process — that would block the deploy
 * from coming up at all and turn a "missing SENTRY_TOKEN" into a complete
 * outage. Instead we log loudly so CI / deploy logs catch it, and let the
 * routes return their own clear 500s when they actually hit the bad env.
 *
 * See Next docs: https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 */
export async function register(): Promise<void> {
  if (process.env["NEXT_RUNTIME"] !== "nodejs") return;
  try {
    // Lazy-import so the edge bundle never pulls Zod or node-crypto via
    // transitive deps.
    const mod = await import("./lib/env.js");
    mod.loadEnv();
    console.info("[crashscope] env validation ok at boot");
  } catch (err: unknown) {
    // We deliberately don't rethrow: a partially-configured deploy should
    // still come up and let request-time handlers produce intelligible 500s,
    // rather than crash-looping with no surface visible to the operator.
    // Redact in case the validation error embedded a partial token in its
    // message (Zod doesn't, today, but defence in depth costs nothing here).
    const { redactError } = await import("./lib/redact.js");
    console.error("[crashscope] env validation failed at boot:", redactError(err));
  }
}
