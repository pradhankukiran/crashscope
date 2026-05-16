# syntax=docker/dockerfile:1.7
#
# Multi-stage Dockerfile for @crashscope/server.
#
# The Next.js app is built with `output: "standalone"` (see next.config.mjs)
# so the final image only needs the trimmed runtime bundle Next emits at
# `.next/standalone/`, plus the static assets at `.next/static/` and the
# `public/` directory. With `outputFileTracingRoot` pointing at the monorepo
# root, Next preserves the workspace layout inside the standalone bundle:
#
#   .next/standalone/
#   ├── node_modules/                  (hoisted from <root>/node_modules)
#   ├── package.json
#   └── packages/
#       ├── core/package.json
#       └── server/
#           ├── node_modules/          (workspace symlinks)
#           ├── package.json
#           └── server.js              <-- runtime entrypoint
#
# The CMD therefore points at `packages/server/server.js` from /app.
#
# Build context expected: the monorepo root. Build with:
#   docker build -f packages/server/Dockerfile .
# (Railway, by way of railway.json, does this automatically.)

# -----------------------------------------------------------------------------
# Stage 1: deps — install pnpm workspace dependencies from the lockfile.
# Cached unless the lockfile or any workspace package.json changes.
# -----------------------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app

# `libc6-compat` keeps Next's swc binary happy on Alpine's musl base.
RUN apk add --no-cache libc6-compat
RUN corepack enable

# Copy every file pnpm reads during a workspace resolve, but no source code.
# Keeping this stage source-free lets Docker reuse the install layer across
# day-to-day code changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/server/package.json ./packages/server/

RUN pnpm install --frozen-lockfile

# -----------------------------------------------------------------------------
# Stage 2: builder — compile @crashscope/core and build the Next.js app.
# -----------------------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app

RUN apk add --no-cache libc6-compat
RUN corepack enable

# Reuse the resolved node_modules from `deps`. Pnpm's content-addressed store
# means a single root `node_modules/.pnpm` plus per-package symlink farms;
# copying the lot is correct.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/packages/server/node_modules ./packages/server/node_modules

# Now bring in the rest of the repo. `.dockerignore` filters out `.next/`,
# `dist/`, `node_modules/`, `.env*`, etc. — see `packages/server/.dockerignore`
# and the root `.dockerignore`.
COPY . .

# Disable Next telemetry inside CI/build environments.
ENV NEXT_TELEMETRY_DISABLED=1

# Build core first (server imports from `@crashscope/core/dist`), then Next.
RUN pnpm --filter @crashscope/core build
RUN pnpm --filter @crashscope/server build

# -----------------------------------------------------------------------------
# Stage 3: runner — minimal runtime image.
# -----------------------------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Railway sets $PORT; Next's standalone server reads it directly. Default to
# 3000 so the image is also runnable locally with `docker run -p 3000:3000`.
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# `wget` is part of busybox in `node:*-alpine`, so the HEALTHCHECK below works
# without extra packages. We still drop privileges to a dedicated user.
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

# Standalone bundle — contains node_modules, package.json, and the Next
# server entrypoint at `packages/server/server.js`.
COPY --from=builder --chown=nextjs:nodejs /app/packages/server/.next/standalone ./
# Static chunks served by the Next server at `/_next/static/*`.
COPY --from=builder --chown=nextjs:nodejs /app/packages/server/.next/static ./packages/server/.next/static
# Public assets served at the site root. Directory may be empty today but
# the COPY is cheap and future-proof.
COPY --from=builder --chown=nextjs:nodejs /app/packages/server/public ./packages/server/public

USER nextjs
EXPOSE 3000

# `/api/health` is a no-auth liveness endpoint (see
# packages/server/src/app/api/health/route.ts). 200 = healthy.
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider "http://127.0.0.1:${PORT}/api/health" || exit 1

CMD ["node", "packages/server/server.js"]
