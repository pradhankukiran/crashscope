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
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
