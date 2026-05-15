/**
 * QuickStart — shadcn Tabs (CLI / Slack / API) with monospace code blocks on
 * a muted background. The same triage pipeline backs every surface; this
 * section just shows how to invoke it from each.
 */

import { MessageSquare, Terminal, Webhook } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface Snippet {
  value: string;
  label: string;
  icon: typeof Terminal;
  language: string;
  code: string;
  blurb: string;
}

const SNIPPETS: Snippet[] = [
  {
    value: "cli",
    label: "CLI",
    icon: Terminal,
    language: "bash",
    code:
      "$ npm i -g crashscope\n" +
      "$ crashscope init\n" +
      "$ crashscope triage --since 24h",
    blurb:
      "Install once, configure your providers interactively, then triage from any terminal.",
  },
  {
    value: "slack",
    label: "Slack",
    icon: MessageSquare,
    language: "text",
    code:
      "/triage\n" +
      "/triage 7d\n" +
      "/triage 24h severity=fatal,error",
    blurb:
      "Add the Slack app, mount this server, and `/triage` from any channel.",
  },
  {
    value: "api",
    label: "API",
    icon: Webhook,
    language: "bash",
    code:
      "$ curl -H 'Authorization: Bearer $TOKEN' \\\n" +
      "       'https://your.vercel.app/api/triage?since=24h&limit=25'",
    blurb:
      "Hit the REST endpoint from CI, internal dashboards, or your own bot.",
  },
];

export function QuickStart(): JSX.Element {
  return (
    <section id="quick-start" className="border-b">
      <div className="mx-auto max-w-6xl px-6 py-16">
        <div className="text-center">
          <h2 className="text-3xl font-bold tracking-tight">
            Three surfaces, one pipeline
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">
            The same triage pipeline backs the CLI, the Slack bot, and the REST
            API. Pick whichever surface fits your workflow.
          </p>
        </div>
        <div className="mt-12">
          <Tabs defaultValue="cli" className="mx-auto max-w-3xl">
            <TabsList className="grid w-full grid-cols-3">
              {SNIPPETS.map((s) => (
                <TabsTrigger key={s.value} value={s.value} className="gap-2">
                  <s.icon className="h-4 w-4" />
                  {s.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {SNIPPETS.map((s) => (
              <TabsContent key={s.value} value={s.value} className="mt-4">
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                    <CardTitle className="text-sm font-medium">
                      {s.label}
                    </CardTitle>
                    <span className="font-mono text-[10px] uppercase text-muted-foreground">
                      {s.language}
                    </span>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    <pre className="overflow-x-auto rounded-md border bg-muted px-4 py-3 font-mono text-sm leading-relaxed text-foreground">
                      <code>{s.code}</code>
                    </pre>
                    <CardDescription>{s.blurb}</CardDescription>
                  </CardContent>
                </Card>
              </TabsContent>
            ))}
          </Tabs>
        </div>
      </div>
    </section>
  );
}
