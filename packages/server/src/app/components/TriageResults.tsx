"use client";

/**
 * TriageResults — render a {@link TriageReport} returned by the public POST
 * endpoint, rebuilt on top of shadcn/ui primitives.
 *
 * Pure presentational: never talks to the API. Severity colors deliberately
 * keep `fatal` and `error` distinct — fatal is a separate Sentry level
 * signalling unhandled crashes and we don't want to flatten it into the
 * regular error band.
 */

import { useMemo } from "react";
import {
  AlertOctagon,
  AlertTriangle,
  ExternalLink,
  Info,
  RotateCcw,
  Terminal,
  Video,
} from "lucide-react";
import type { TriageIssue, TriageReport } from "@pradhankukiran/crashscope-core";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

import { CopyButton } from "./CopyButton";

export interface TriageResultsProps {
  report: TriageReport;
  /** When provided, shown as a "Run again" button in the summary header. */
  onReset?: () => void;
}

// ----- Severity styling ----------------------------------------------------

type SeverityKey = TriageIssue["severity"];
type ConfidenceKey = TriageIssue["confidence"];

interface SeverityStyle {
  /** Badge classes for the severity pill. */
  pill: string;
  /** Dot color shown beside the issue title. */
  dot: string;
  /** Icon to render inline with the severity. */
  Icon: typeof AlertOctagon;
}

const SEVERITY_STYLE: Record<SeverityKey, SeverityStyle> = {
  fatal: {
    pill: "bg-red-100 text-red-700 border-red-200 hover:bg-red-100",
    dot: "bg-red-500",
    Icon: AlertOctagon,
  },
  error: {
    pill: "bg-orange-100 text-orange-700 border-orange-200 hover:bg-orange-100",
    dot: "bg-orange-500",
    Icon: AlertOctagon,
  },
  warning: {
    pill: "bg-amber-100 text-amber-800 border-amber-200 hover:bg-amber-100",
    dot: "bg-amber-500",
    Icon: AlertTriangle,
  },
  info: {
    pill: "bg-sky-100 text-sky-700 border-sky-200 hover:bg-sky-100",
    dot: "bg-sky-500",
    Icon: Info,
  },
};

const CONFIDENCE_LABEL: Record<ConfidenceKey, string> = {
  high: "High confidence",
  med: "Medium confidence",
  low: "Low confidence",
};

const CONFIDENCE_STYLE: Record<ConfidenceKey, string> = {
  high: "bg-emerald-100 text-emerald-700 border-emerald-200 hover:bg-emerald-100",
  med: "bg-amber-100 text-amber-800 border-amber-200 hover:bg-amber-100",
  low: "bg-muted text-muted-foreground border-transparent hover:bg-muted",
};

// ----- Helpers -------------------------------------------------------------

function formatRelative(iso: string, now: number = Date.now()): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "—";
  const diff = Math.max(0, now - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month}mo ago`;
  const yr = Math.floor(day / 365);
  return `${yr}y ago`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s - m * 60);
  return `${m}m ${rs}s`;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/**
 * Return `raw` only if it parses as a `http:` or `https:` URL. Anything else
 * — `javascript:`, `data:`, `file:`, malformed — returns `null` and the caller
 * is expected to render the affiliated UI as disabled / omitted.
 *
 * Adapters *should* only ever produce http(s) URLs, but the public POST
 * endpoint forwards adapter output into a React tree we render in the same
 * page that asked for the credentials; one bad URL field upstream would
 * become a clickable XSS vector via `<a href="javascript:...">`. Defence in
 * depth.
 */
function safeHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

// ----- Component ----------------------------------------------------------

export function TriageResults({
  report,
  onReset,
}: TriageResultsProps): JSX.Element {
  // Cap `now` for the lifetime of a render so relative timestamps stay stable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), [report]);
  const empty = report.issues.length === 0;

  return (
    <div className="flex flex-col gap-6">
      {empty ? null : <InstallCliCallout />}
      <SummaryCard report={report} {...(onReset ? { onReset } : {})} />
      {empty ? (
        <EmptyState window={report.window} />
      ) : (
        <div className="flex flex-col">
          {report.issues.map((issue, i) => (
            <div key={issue.errorId}>
              {i > 0 ? <Separator className="my-6" /> : null}
              <IssueCard issue={issue} now={now} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ----- Install CLI callout -------------------------------------------------

const INSTALL_LINES = ["$ npm i -g crashscope", "$ crashscope init && crashscope triage"];
const INSTALL_CLIPBOARD = "npm i -g crashscope\ncrashscope init && crashscope triage";

function InstallCliCallout(): JSX.Element {
  return (
    <Card className="border-primary/20 bg-primary/5 shadow-none">
      <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Terminal className="h-5 w-5" />
          </span>
          <div className="flex flex-col gap-2">
            <h3 className="text-base font-semibold text-foreground">
              Loved it? Run this on your terminal anytime.
            </h3>
            <pre className="overflow-x-auto rounded-md border bg-background px-3 py-2 font-mono text-xs leading-relaxed text-foreground">
              <code>{INSTALL_LINES.join("\n")}</code>
            </pre>
          </div>
        </div>
        <div className="shrink-0 sm:self-center">
          <CopyButton
            value={INSTALL_CLIPBOARD}
            label="Copy install command"
            ariaLabel="Copy install command"
            variant="default"
            size="sm"
          />
        </div>
      </CardContent>
    </Card>
  );
}

// ----- Subcomponents ------------------------------------------------------

function SummaryCard({
  report,
  onReset,
}: {
  report: TriageReport;
  onReset?: () => void;
}): JSX.Element {
  const { summary, window, meta } = report;
  return (
    <Card>
      <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <CardTitle>Triage Report</CardTitle>
          <CardDescription>
            Window: <span className="font-medium">{window}</span> · Took{" "}
            {formatDuration(meta.durationMs)}
          </CardDescription>
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge
              variant="outline"
              className="border-red-200 bg-red-50 text-red-700"
            >
              {summary.high} high
            </Badge>
            <Badge
              variant="outline"
              className="border-amber-200 bg-amber-50 text-amber-800"
            >
              {summary.med} med
            </Badge>
            <Badge
              variant="outline"
              className="border-sky-200 bg-sky-50 text-sky-700"
            >
              {summary.low} low
            </Badge>
            <Badge variant="secondary">total {summary.total}</Badge>
          </div>
        </div>
        <div className="flex flex-col items-start gap-2 text-xs text-muted-foreground sm:items-end">
          <span className="font-mono">
            {meta.errorProvider} → {meta.sessionProvider}
          </span>
          {onReset ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onReset}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Run again
            </Button>
          ) : null}
        </div>
      </CardHeader>
    </Card>
  );
}

function EmptyState({ window }: { window: string }): JSX.Element {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
        <p className="text-sm font-medium">Nothing to triage in the {window}.</p>
        <p className="text-xs text-muted-foreground">
          Either your providers are quiet, or your filter is too tight. Try a
          wider window.
        </p>
      </CardContent>
    </Card>
  );
}

function IssueCard({
  issue,
  now,
}: {
  issue: TriageIssue;
  now: number;
}): JSX.Element {
  const style = SEVERITY_STYLE[issue.severity];
  return (
    <Card className="shadow-none">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant="outline"
                className={cn("uppercase tracking-wider", style.pill)}
              >
                <style.Icon className="h-3.5 w-3.5" />
                {issue.severity}
              </Badge>
              <span
                className={cn(
                  "inline-block h-1.5 w-1.5 rounded-full",
                  style.dot,
                )}
                aria-hidden
              />
              <CardTitle className="text-sm font-mono">
                {issue.title}
              </CardTitle>
              <Badge variant="secondary" className="font-mono">
                {issue.provider}
              </Badge>
              {issue.environment ? (
                <Badge variant="outline" className="font-mono text-xs">
                  env: {issue.environment}
                </Badge>
              ) : null}
              {issue.releaseVersion ? (
                <Badge variant="outline" className="font-mono text-xs">
                  release: {issue.releaseVersion}
                </Badge>
              ) : null}
            </div>
            <CardDescription>
              {issue.affectedUsers.toLocaleString()} user
              {issue.affectedUsers === 1 ? "" : "s"} ·{" "}
              {issue.eventCount.toLocaleString()} event
              {issue.eventCount === 1 ? "" : "s"} · last{" "}
              {formatRelative(issue.lastSeen, now)}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <Block label="User flow" body={issue.userJourney} />
        <Block label="Hypothesis" body={issue.hypothesis} />
        <Block label="Root cause" body={issue.rootCauseGuess} />

        {issue.suggestedFiles.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Check
            </span>
            {issue.suggestedFiles.map((f) => (
              <code
                key={f}
                className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground"
              >
                {f}
              </code>
            ))}
          </div>
        ) : null}

        <Separator />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <SourceLink
              href={safeHref(issue.sourceUrl)}
              label={`Open in ${capitalize(issue.provider)}`}
            />
            <ReplayLink href={safeHref(issue.replayUrl)} />
          </div>
          <Badge
            variant="outline"
            className={cn(CONFIDENCE_STYLE[issue.confidence])}
          >
            {CONFIDENCE_LABEL[issue.confidence]}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}

function Block({ label, body }: { label: string; body: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
        {body}
      </p>
    </div>
  );
}

/**
 * Render an external "open in provider" link only when the URL passed
 * {@link safeHref}. If the upstream URL was missing or used a non-http(s)
 * scheme, we show a disabled visual instead of a broken or weaponised link.
 */
function SourceLink({
  href,
  label,
}: {
  href: string | null;
  label: string;
}): JSX.Element {
  if (!href) {
    return (
      <span
        className="inline-flex cursor-not-allowed items-center gap-1.5 text-xs font-medium text-muted-foreground"
        aria-disabled
        title="Source URL unavailable"
      >
        {label}
        <ExternalLink className="h-3 w-3" />
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
    >
      {label}
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}

/**
 * Render the "Watch replay" link if the upstream URL is a safe http(s).
 * Returns `null` entirely when the URL is missing or unsafe: replay isn't a
 * core affordance, so we keep the UI clean rather than show a disabled stub.
 */
function ReplayLink({ href }: { href: string | null }): JSX.Element | null {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
    >
      <Video className="h-3 w-3" />
      Watch replay
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}
