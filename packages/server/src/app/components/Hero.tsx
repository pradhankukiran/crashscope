/**
 * Top-of-page hero. Clean, minimal, no flashy gradients.
 *
 * Headline + subhead + single CTA + a static preview of a sample triage card
 * so visitors see what the product actually produces before scrolling.
 */

import {
  AlertOctagon,
  ExternalLink,
  Triangle,
  Video,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
} from "@/components/ui/card";

const DEPLOY_URL =
  "https://vercel.com/new/clone?repository-url=" +
  encodeURIComponent(
    "https://github.com/crashscope/crashscope/tree/main/packages/server",
  );

export function Hero(): JSX.Element {
  return (
    <section className="border-b">
      <div className="mx-auto max-w-6xl px-6 pt-20 pb-12 text-center sm:pt-24">
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
        <div className="mt-10 flex justify-center">
          <Button asChild size="lg">
            <a href={DEPLOY_URL}>
              <Triangle className="h-4 w-4 fill-current" />
              Deploy to Vercel
            </a>
          </Button>
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          Bring your own Anthropic API key. Credentials never leave your
          browser beyond a single request.
        </p>
      </div>

      {/* Sample triage card preview */}
      <div className="mx-auto max-w-3xl px-6 pb-20">
        <div className="mb-3 flex items-center justify-between">
          <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            Sample output
          </span>
          <span className="font-mono text-[11px] text-muted-foreground">
            sentry → posthog · 47s
          </span>
        </div>
        <Card className="border-red-200 shadow-sm">
          <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
            <div className="flex items-start gap-3">
              <span className="mt-1 inline-flex h-7 w-7 items-center justify-center rounded-md bg-red-50 text-red-600">
                <AlertOctagon className="h-4 w-4" />
              </span>
              <div className="text-left">
                <Badge variant="outline" className="border-red-200 bg-red-50 text-red-700">
                  HIGH · fatal
                </Badge>
                <h3 className="mt-2 font-mono text-base font-semibold text-foreground">
                  TypeError in SupplementCard.tsx:42
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  23 users · 47 events · last 1h · since deploy v2.3.1
                </p>
              </div>
            </div>
            <Badge variant="secondary" className="shrink-0 font-normal">
              sentry
            </Badge>
          </CardHeader>
          <CardContent className="space-y-4 text-left text-sm">
            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                User flow
              </div>
              <p className="mt-1 leading-relaxed">
                User completed steps 1–10 of onboarding, then on step 11 tried
                to add &ldquo;Vitamin D3 + K2&rdquo;. Error fired when the
                supplement name contained &ldquo;+&rdquo;. User rage-clicked 4×
                then abandoned.
              </p>
            </div>
            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Hypothesis
              </div>
              <p className="mt-1 leading-relaxed">
                URL encoding on the supplement name parameter. The literal
                &ldquo;+&rdquo; is being decoded to a space before reaching the
                scanner.
              </p>
            </div>
            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Check
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {[
                  "lib/scanner/parse.ts:18",
                  "app/scan/[id]/page.tsx",
                  "lib/url.ts",
                ].map((f) => (
                  <code
                    key={f}
                    className="rounded bg-muted px-2 py-0.5 font-mono text-[12px] text-foreground"
                  >
                    {f}
                  </code>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between pt-2">
              <div className="flex gap-2">
                <Button asChild size="sm" variant="outline">
                  <span className="cursor-default">
                    <Video className="h-3.5 w-3.5" />
                    Watch replay
                  </span>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <span className="cursor-default">
                    <ExternalLink className="h-3.5 w-3.5" />
                    Open in Sentry
                  </span>
                </Button>
              </div>
              <Badge variant="outline" className="font-normal">
                confidence · high
              </Badge>
            </div>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
