import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Content-Security-Policy applied to all responses.
 *
 * The directives are intentionally on the permissive side for `script-src`
 * and `style-src` because shadcn/ui + `next/font` ship inline `<style>` tags
 * at runtime and Next emits a handful of inline init scripts. Tightening to
 * `'strict-dynamic'` + nonces is a viable follow-up but requires plumbing the
 * nonce through middleware; documented as out of scope here.
 *
 * `connect-src` enumerates every error / session / telemetry adapter target
 * we know about, plus Anthropic, so the public demo's outbound `fetch`
 * calls from the browser (none today, but defensive) won't be silently
 * blocked if we ever add them.
 */
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' https://us.i.posthog.com https://*.ingest.sentry.io https://api.rollbar.com https://api.bugsnag.com https://app.honeybadger.io https://*.logrocket.io https://api.anthropic.com",
  "img-src 'self' data:",
  "font-src 'self' data:",
].join("; ");

const securityHeaders = [
  // Force TLS for two years, opt into preload list, cover subdomains.
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  // Prevent MIME-type sniffing — pair with Content-Type set by Next.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Send full referrer same-origin, only origin cross-origin. Default in
  // modern browsers but pin it explicitly for older clients.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // We don't use any of these surfaces; deny by default so a third-party
  // script can't try to.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  { key: "Content-Security-Policy", value: csp },
];

// Resolve the monorepo root (two levels up from `packages/server/`). Passing
// this to `outputFileTracingRoot` tells Next's standalone tracer to anchor
// its file-tracing at the workspace root, which keeps the generated paths
// inside `.next/standalone/` predictable for Docker (`packages/server/server.js`
// rather than something derived from a guessed root).
const __dirname = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(__dirname, "../..");

// Vercel uploads only `packages/server/` to the build container, so the
// monorepo-anchored Docker config (`output: "standalone"` +
// `outputFileTracingRoot` pointing two levels up) breaks under Vercel:
// the tracer produces doubled paths like `/vercel/path0/vercel/path0/.next/...`
// because Vercel itself wraps the build dir. Detect Vercel via its built-in
// env var and let Vercel use Next's default serverless output instead.
const isVercel = !!process.env.VERCEL;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@pradhankukiran/crashscope-core"],
  // Emit a self-contained Node server at `.next/standalone/` for Docker.
  // The runtime entrypoint is `packages/server/server.js` relative to the
  // standalone output (Next preserves the monorepo layout inside it). Vercel
  // skips standalone — it has its own serverless packaging.
  // See: https://nextjs.org/docs/pages/api-reference/next-config-js/output
  ...(isVercel ? {} : { output: "standalone" }),
  experimental: {
    typedRoutes: true,
    // Enable the `src/instrumentation.ts` hook so we can validate env at
    // boot. Default is `false` in Next 14; auto-on from Next 15.
    instrumentationHook: true,
    serverComponentsExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
    // Anchor file tracing at the workspace root so hoisted pnpm deps under
    // `<root>/node_modules/.pnpm/...` get copied into the standalone bundle.
    // Without this, Next warns and guesses a root which may miss workspace
    // packages. In Next 14 this lives under `experimental`; promoted to the
    // top level in Next 15.
    //
    // On Vercel, omit this — the parent monorepo isn't part of the build
    // context, so anchoring there would produce nonsense paths.
    ...(isVercel ? {} : { outputFileTracingRoot: monorepoRoot }),
  },
  async headers() {
    return [
      {
        // Apply to everything; the API routes also set `Cache-Control: no-store`
        // on their own, which composes fine with these.
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
