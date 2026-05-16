/**
 * Deploy section — three concrete self-host paths with copy-pasteable
 * commands and one-click deploy buttons where the upstream platforms
 * support them. Pitched at developers who like to read the recipe before
 * pushing the button.
 */

import {
  ArrowRight,
  Box,
  Container,
  Server,
  Triangle,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

import { TerminalSnippet } from "./TerminalSnippet";

const REPO_URL = "https://github.com/pradhankukiran/crashscope";

const VERCEL_DEPLOY_URL =
  "https://vercel.com/new/clone?" +
  new URLSearchParams({
    "repository-url": REPO_URL,
    "project-name": "crashscope",
    "root-directory": "packages/server",
    env: [
      "ANTHROPIC_API_KEY",
      "CRASHSCOPE_API_TOKEN",
      "ERROR_PROVIDER",
      "SENTRY_TOKEN",
      "SENTRY_ORG",
      "SENTRY_PROJECT",
      "SESSION_PROVIDER",
      "POSTHOG_API_KEY",
      "POSTHOG_PROJECT_ID",
    ].join(","),
    envDescription:
      "Provider credentials for the GET endpoint and Slack bot. The public POST demo does not require any of these.",
    envLink:
      "https://github.com/pradhankukiran/crashscope/blob/master/packages/server/.env.example",
  }).toString();

// Railway has no working "deploy this arbitrary GitHub repo via URL" pattern —
// their /new/template URLs require a pre-published Railway template id, not a
// GitHub URL. Linking the button to /new lands the visitor on Railway's
// project-picker where they can pick "Deploy from GitHub repo".
const RAILWAY_DEPLOY_URL = "https://railway.com/new";

// Render IS happy to deploy from any GitHub URL; the optional render.yaml at
// the repo root would let it auto-configure, but even without one this flow
// works.
const RENDER_DEPLOY_URL =
  "https://render.com/deploy?repo=" + encodeURIComponent(REPO_URL);

const RAILWAY_LINES = [
  "$ git clone https://github.com/pradhankukiran/crashscope.git",
  "$ cd crashscope",
  "$ railway init && railway up",
] as const;

const VERCEL_LINES = [
  "$ git clone https://github.com/pradhankukiran/crashscope.git",
  "$ cd crashscope/packages/server",
  "$ vercel deploy",
] as const;

const DOCKER_LINES = [
  "$ git clone https://github.com/pradhankukiran/crashscope.git",
  "$ cd crashscope",
  "$ cp packages/server/.env.example packages/server/.env.local",
  "$ docker compose up -d",
] as const;

const RENDER_LINES = [
  "# render auto-detects Dockerfile in the repo",
  "$ git clone https://github.com/pradhankukiran/crashscope.git",
  "# then in Render dashboard: New + Web Service",
  "# point at this repo, Render reads packages/server/Dockerfile",
] as const;

interface DeployTarget {
  key: string;
  title: string;
  Icon: typeof Triangle;
  description: string;
  badge?: string;
  oneClickUrl?: string;
  oneClickLabel?: string;
  lines: readonly string[];
  copyValue: string;
  copyAriaLabel: string;
  tradeoff: string;
}

const TARGETS: readonly DeployTarget[] = [
  {
    key: "railway",
    title: "Railway",
    Icon: Server,
    description:
      "Long-running Node process. Best fit for crashscope — Slack background jobs and multi-minute Claude investigations both run without serverless quirks.",
    badge: "Recommended",
    oneClickUrl: RAILWAY_DEPLOY_URL,
    oneClickLabel: "Open Railway",
    lines: RAILWAY_LINES,
    copyValue: RAILWAY_LINES.map((l) => l.replace(/^\$\s*/, "")).join("\n"),
    copyAriaLabel: "Copy Railway deploy commands",
    tradeoff: "From $5/mo. Free trial credits included.",
  },
  {
    key: "vercel",
    title: "Vercel",
    Icon: Triangle,
    description:
      "Familiar one-click serverless deploy. Slack background jobs use `waitUntil`; long Claude investigations have a 300s function ceiling.",
    oneClickUrl: VERCEL_DEPLOY_URL,
    oneClickLabel: "Deploy on Vercel",
    lines: VERCEL_LINES,
    copyValue: VERCEL_LINES.map((l) => l.replace(/^\$\s*/, "")).join("\n"),
    copyAriaLabel: "Copy Vercel deploy commands",
    tradeoff: "Free tier covers most teams.",
  },
  {
    key: "render",
    title: "Render",
    Icon: Server,
    description:
      "Long-running container host. Reads the Dockerfile in the repo, no extra config — same runtime model as Railway with a different control plane.",
    oneClickUrl: RENDER_DEPLOY_URL,
    oneClickLabel: "Deploy on Render",
    lines: RENDER_LINES,
    copyValue: RENDER_LINES.map((l) => l.replace(/^[$#]\s*/, "")).join("\n"),
    copyAriaLabel: "Copy Render deploy commands",
    tradeoff: "Free tier for hobby services.",
  },
  {
    key: "docker",
    title: "Docker",
    Icon: Container,
    description:
      "Same image runs on any container host — Render, Fly.io, Cloud Run, Fargate, your own VPS, or Kubernetes. The Dockerfile + docker-compose.yml in the repo are the canonical artifacts.",
    lines: DOCKER_LINES,
    copyValue: DOCKER_LINES.map((l) => l.replace(/^\$\s*/, "")).join("\n"),
    copyAriaLabel: "Copy Docker compose commands",
    tradeoff: "Bring your own host.",
  },
];

export function Deploy(): JSX.Element {
  return (
    <section id="deploy" className="border-b bg-muted/30">
      <div className="mx-auto max-w-6xl px-6 py-16">
        <div className="text-center">
          <h2 className="text-3xl font-bold tracking-tight">
            Run your own instance
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">
            Same code, your infrastructure. Visitors of your deployment paste
            their own credentials into the demo form — you don&apos;t hold
            anyone&apos;s keys.
          </p>
        </div>

        <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {TARGETS.map((target) => (
            <Card
              key={target.key}
              className={
                target.badge
                  ? "relative border-primary/30 bg-primary/5 shadow-sm"
                  : "relative shadow-sm"
              }
            >
              {target.badge ? (
                <Badge className="absolute right-4 top-4">{target.badge}</Badge>
              ) : null}
              <CardHeader className="space-y-3 pb-4">
                <div className="flex items-center gap-3">
                  <span
                    className={
                      target.badge
                        ? "inline-flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary"
                        : "inline-flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-foreground"
                    }
                  >
                    <target.Icon className="h-5 w-5" />
                  </span>
                  <CardTitle className="text-xl">{target.title}</CardTitle>
                </div>
                <CardDescription className="leading-relaxed">
                  {target.description}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {target.oneClickUrl ? (
                  <a
                    href={target.oneClickUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center gap-2 rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/90"
                  >
                    {target.oneClickLabel}
                    <ArrowRight className="h-3.5 w-3.5" />
                  </a>
                ) : null}

                <div>
                  <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    {target.oneClickUrl ? "Or via CLI" : "From the terminal"}
                  </p>
                  <TerminalSnippet
                    lines={target.lines}
                    copyValue={target.copyValue}
                    copyAriaLabel={target.copyAriaLabel}
                  />
                </div>

                <p className="text-xs text-muted-foreground">
                  {target.tradeoff}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="mt-10 rounded-lg border bg-background p-5">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <Box className="h-4 w-4" />
            </span>
            <div className="space-y-2 text-sm">
              <p className="font-medium text-foreground">
                Env vars you&apos;ll need
              </p>
              <p className="text-muted-foreground">
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">
                  ANTHROPIC_API_KEY
                </code>
                ,{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">
                  CRASHSCOPE_API_TOKEN
                </code>
                , your error provider (
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">
                  ERROR_PROVIDER
                </code>{" "}
                + credentials), and your session provider (
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">
                  SESSION_PROVIDER
                </code>{" "}
                + credentials). Optional: Slack signing secret + bot token,
                Upstash Redis for distributed rate-limiting.
              </p>
              <p className="text-muted-foreground">
                The public{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">
                  POST /api/triage
                </code>{" "}
                demo accepts credentials in the request body, so you can deploy
                without any provider env vars and visitors still get a working
                triage experience.{" "}
                <a
                  href={`${REPO_URL}/blob/master/packages/server/.env.example`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-primary underline-offset-4 hover:underline"
                >
                  Full env reference →
                </a>
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
