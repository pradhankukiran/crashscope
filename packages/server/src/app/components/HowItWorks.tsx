/**
 * "How it works" — four-step horizontal flow describing the pipeline from
 * error capture through to triage delivery. Each step is a shadcn Card with
 * a lucide icon.
 */

import {
  Bug,
  type LucideIcon,
  PlayCircle,
  Send,
  Sparkles,
} from "lucide-react";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface Step {
  index: number;
  title: string;
  body: string;
  Icon: LucideIcon;
}

const STEPS: Step[] = [
  {
    index: 1,
    title: "Fetch errors",
    body: "Pull recent issues from Sentry, Rollbar, Bugsnag, or Honeybadger.",
    Icon: Bug,
  },
  {
    index: 2,
    title: "Find the session",
    body: "Match each affected user to a PostHog or LogRocket session.",
    Icon: PlayCircle,
  },
  {
    index: 3,
    title: "Investigate",
    body: "Claude analyses the stack + user journey and emits a structured finding.",
    Icon: Sparkles,
  },
  {
    index: 4,
    title: "Deliver",
    body: "Report goes to Slack, your terminal, or your API consumer.",
    Icon: Send,
  },
];

export function HowItWorks(): JSX.Element {
  return (
    <section id="how-it-works" className="border-b">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <div className="text-center">
          <h2 className="text-3xl font-bold tracking-tight">How it works</h2>
          <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">
            A deterministic adapter layer feeds a Claude investigation, so the
            model gets just the signals it needs — no provider-specific
            prompts.
          </p>
        </div>
        <ol className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s) => (
            <li key={s.index}>
              <Card className="h-full shadow-sm">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs text-muted-foreground">
                      STEP {s.index.toString().padStart(2, "0")}
                    </span>
                    <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                      <s.Icon className="h-5 w-5" />
                    </span>
                  </div>
                  <CardTitle className="pt-4 text-lg">{s.title}</CardTitle>
                  <CardDescription className="leading-relaxed">
                    {s.body}
                  </CardDescription>
                </CardHeader>
              </Card>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
