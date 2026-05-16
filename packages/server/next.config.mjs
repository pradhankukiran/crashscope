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

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@crashscope/core"],
  experimental: {
    typedRoutes: true,
    // Enable the `src/instrumentation.ts` hook so we can validate env at
    // boot. Default is `false` in Next 14; auto-on from Next 15.
    instrumentationHook: true,
    serverComponentsExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
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
