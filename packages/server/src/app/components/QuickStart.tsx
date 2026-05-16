/**
 * QuickStart — repositions the CLI as the hero of this section. The Slack
 * bot and REST API are presented underneath as team upgrades, not equivalents.
 *
 * Layout:
 *   1. Big featured CLI card (full width, copyable install snippet).
 *   2. Separator labelled "For teams".
 *   3. Two-column grid: Slack bot + REST API. Both end with a small note
 *      pointing back at the server deploy story.
 */

import { type LucideIcon, MessageSquare, Terminal, Webhook } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

import { TerminalSnippet } from "./TerminalSnippet";

const CLI_LINES = [
  "$ npm i -g @pradhankukiran/crashscope",
  "$ crashscope init",
  "$ crashscope triage --since 24h",
] as const;
const CLI_CLIPBOARD =
  "npm i -g @pradhankukiran/crashscope\ncrashscope init\ncrashscope triage --since 24h";

interface TeamSurface {
  key: string;
  label: string;
  blurb: string;
  Icon: LucideIcon;
  language: string;
  lines: readonly string[];
}

const TEAM_SURFACES: readonly TeamSurface[] = [
  {
    key: "slack",
    label: "Slack bot",
    blurb:
      "Add the Slack app, mount this server, and trigger triage from any channel.",
    Icon: MessageSquare,
    language: "slash command",
    lines: ["/triage", "/triage 7d", "/triage 24h severity=fatal,error"],
  },
  {
    key: "api",
    label: "REST API",
    blurb:
      "Hit the REST endpoint from CI, internal dashboards, or your own bot.",
    Icon: Webhook,
    language: "bash",
    lines: [
      "$ curl -H 'Authorization: Bearer $TOKEN' \\",
      "       'https://your.vercel.app/api/triage?since=24h&limit=25'",
    ],
  },
];

export function QuickStart(): JSX.Element {
  return (
    <section id="quick-start" className="border-b">
      <div className="mx-auto max-w-6xl px-6 py-16">
        <div className="text-center">
          <h2 className="text-3xl font-bold tracking-tight">
            Get started
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">
            Install the CLI once. Deploy the server later if your team wants
            the same triage from Slack or REST.
          </p>
        </div>

        {/* CLI hero card */}
        <div className="mt-12">
          <Card className="relative border-primary/20 bg-primary/5 shadow-sm">
            <Badge className="absolute right-4 top-4">Recommended</Badge>
            <CardHeader className="space-y-3 p-8 pb-4">
              <div className="flex items-center gap-3">
                <span className="inline-flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Terminal className="h-6 w-6" />
                </span>
                <CardTitle className="text-2xl">
                  The CLI is the product
                </CardTitle>
              </div>
              <CardDescription className="text-base">
                One install. Triage from any terminal.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-8 pt-2">
              <TerminalSnippet
                lines={CLI_LINES}
                copyValue={CLI_CLIPBOARD}
                copyAriaLabel="Copy CLI commands"
              />
            </CardContent>
          </Card>
        </div>

        {/* For-teams divider */}
        <div className="mt-16 flex items-center gap-4">
          <Separator className="flex-1" />
          <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
            For teams
          </span>
          <Separator className="flex-1" />
        </div>

        {/* Team upgrades grid */}
        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {TEAM_SURFACES.map((s) => (
            <Card key={s.key} className="shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                <div className="flex items-center gap-2.5">
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <s.Icon className="h-4 w-4" />
                  </span>
                  <CardTitle className="text-base">{s.label}</CardTitle>
                </div>
                <span className="font-mono text-[10px] uppercase text-muted-foreground">
                  {s.language}
                </span>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <pre className="overflow-x-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs leading-relaxed text-foreground">
                  <code>{s.lines.join("\n")}</code>
                </pre>
                <CardDescription>{s.blurb}</CardDescription>
              </CardContent>
            </Card>
          ))}
        </div>
        <p className="mt-4 text-center text-xs text-muted-foreground">
          Deploy the server to enable these →
        </p>
      </div>
    </section>
  );
}
