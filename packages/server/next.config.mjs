/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The workspace dep ships ESM dist but Next benefits from transpiling
  // workspace packages so types and source maps resolve cleanly.
  transpilePackages: ["@crashscope/core"],
  experimental: {
    typedRoutes: true,
    // Keep Node-only deps out of the server-component bundler so they
    // resolve at runtime via Node module resolution instead of being
    // packed into Webpack output.
    serverComponentsExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
  },
};

export default nextConfig;
