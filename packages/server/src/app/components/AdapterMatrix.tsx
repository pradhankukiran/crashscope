/**
 * Adapter matrix — grid of cards listing the four error trackers and two
 * session-replay providers crashscope supports out of the box.
 *
 * Label-only (no logos) to avoid the legal complications of redistributing
 * third-party trademarks inside the package.
 */

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type Role = "error" | "session";

interface Adapter {
  name: string;
  role: Role;
  blurb: string;
}

const ADAPTERS: Adapter[] = [
  {
    name: "Sentry",
    role: "error",
    blurb: "Issues, events, breadcrumbs via the public REST API.",
  },
  {
    name: "Rollbar",
    role: "error",
    blurb: "Items, occurrences, and tracebacks via Rollbar's read API.",
  },
  {
    name: "Bugsnag",
    role: "error",
    blurb: "Errors and events from the Bugsnag Data Access API.",
  },
  {
    name: "Honeybadger",
    role: "error",
    blurb: "Faults and notices from Honeybadger's v2 API.",
  },
  {
    name: "PostHog",
    role: "session",
    blurb: "Session recordings + person events keyed by user id.",
  },
  {
    name: "LogRocket",
    role: "session",
    blurb: "Sessions and events from the LogRocket public API.",
  },
];

function RoleBadge({ role }: { role: Role }): JSX.Element {
  return role === "error" ? (
    <Badge
      variant="outline"
      className="border-red-200 bg-red-50 text-red-700"
    >
      Error tracker
    </Badge>
  ) : (
    <Badge
      variant="outline"
      className="border-sky-200 bg-sky-50 text-sky-700"
    >
      Session replay
    </Badge>
  );
}

export function AdapterMatrix(): JSX.Element {
  return (
    <section id="adapters" className="border-b">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <div className="text-center">
          <h2 className="text-3xl font-bold tracking-tight">
            Bring your existing stack
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">
            Adapters live in{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm text-primary">
              @crashscope/core
            </code>{" "}
            and normalize each provider into a shared error and session shape.
          </p>
        </div>
        <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ADAPTERS.map((a) => (
            <Card key={a.name} className="shadow-sm transition-shadow hover:shadow-md">
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="text-lg">{a.name}</CardTitle>
                  <RoleBadge role={a.role} />
                </div>
              </CardHeader>
              <CardContent>
                <CardDescription className="leading-relaxed">
                  {a.blurb}
                </CardDescription>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
