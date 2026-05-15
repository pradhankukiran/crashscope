/**
 * Top-of-page hero. Clean, minimal, no flashy gradients.
 *
 * Renders the eyebrow chip, headline, sub-headline, and the two primary CTAs
 * (Deploy to Vercel + GitHub). Kept as a server component — no client state.
 */

import { ArrowRight, Triangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const DEPLOY_URL =
  "https://vercel.com/new/clone?repository-url=" +
  encodeURIComponent(
    "https://github.com/crashscope/crashscope/tree/main/packages/server",
  );

const GITHUB_URL = "https://github.com/crashscope/crashscope";

export function Hero(): JSX.Element {
  return (
    <section className="border-b">
      <div className="mx-auto max-w-6xl px-6 py-24 text-center sm:py-32">
        <Badge variant="secondary" className="rounded-full font-normal">
          AI triage that knows what the user did before the crash
        </Badge>
        <h1 className="mt-6 text-4xl font-bold tracking-tight text-foreground sm:text-6xl">
          AI-powered error triage
          <br className="hidden sm:block" />
          <span className="text-primary"> for your stack.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-base text-muted-foreground sm:text-lg">
          Crashscope joins your error tracker with session replay and uses
          Claude to produce ranked, actionable triage reports — for Slack, the
          CLI, or your own automation via REST.
        </p>
        <div className="mt-10 flex flex-col justify-center gap-3 sm:flex-row">
          <Button asChild size="lg">
            <a href={DEPLOY_URL}>
              <Triangle className="h-4 w-4 fill-current" />
              Deploy to Vercel
            </a>
          </Button>
          <Button asChild size="lg" variant="outline">
            <a href={GITHUB_URL}>
              View on GitHub
              <ArrowRight className="h-4 w-4" />
            </a>
          </Button>
        </div>
        <p className="mt-6 text-xs text-muted-foreground">
          Bring your own Anthropic API key. No data ever leaves your providers
          beyond what you authorize.
        </p>
      </div>
    </section>
  );
}
