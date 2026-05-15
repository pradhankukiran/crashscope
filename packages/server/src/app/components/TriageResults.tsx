"use client";

/**
 * TriageResults — render a {@link TriageReport} the public POST endpoint
 * returned. Drawn directly underneath the demo form on the landing page.
 *
 * This component is presentation-only: it never talks to the API. Everything
 * it needs comes through props.
 *
 * Severity colors deliberately keep `fatal` and `error` distinct (red vs.
 * orange) — fatal in Sentry is a separate level signalling unhandled crashes
 * and we don't want to flatten it into the regular error band.
 */

import { useMemo } from "react";
import type { TriageIssue, TriageReport } from "@crashscope/core";

export interface TriageResultsProps {
  report: TriageReport;
  /** When provided, shown as a "Run again" button in the header. */
  onReset?: () => void;
}

// ----- Severity styling ----------------------------------------------------

interface SeverityTokens {
  pill: string;
  card: string;
}

const SEVERITY: Record<TriageIssue["severity"], SeverityTokens> = {
  fatal: {
    pill: "bg-red-500/15 text-red-300 border-red-500/40 ring-red-500/30",
    card: "border-red-500/30",
  },
  error: {
    pill: "bg-orange-500/15 text-orange-300 border-orange-500/40 ring-orange-500/30",
    card: "border-orange-500/30",
  },
  warning: {
    pill: "bg-amber-500/15 text-amber-300 border-amber-500/40 ring-amber-500/30",
    card: "border-amber-500/30",
  },
  info: {
    pill: "bg-blue-500/15 text-blue-300 border-blue-500/40 ring-blue-500/30",
    card: "border-blue-500/30",
  },
};

const CONFIDENCE_LABEL: Record<TriageIssue["confidence"], string> = {
  high: "Confidence: high",
  med: "Confidence: medium",
  low: "Confidence: low",
};

const CONFIDENCE_PILL: Record<TriageIssue["confidence"], string> = {
  high: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  med: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  low: "bg-ink-500/15 text-ink-300 border-ink-500/40",
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

// ----- Component ----------------------------------------------------------

export function TriageResults({
  report,
  onReset,
}: TriageResultsProps): JSX.Element {
  const now = useMemo(() => Date.now(), [report]);
  const empty = report.issues.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <Header report={report} {...(onReset ? { onReset } : {})} />
      {empty ? (
        <EmptyState window={report.window} />
      ) : (
        <ul className="flex flex-col gap-4">
          {report.issues.map((issue) => (
            <li key={issue.errorId}>
              <IssueCard issue={issue} now={now} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ----- Subcomponents ------------------------------------------------------

function Header({
  report,
  onReset,
}: {
  report: TriageReport;
  onReset?: () => void;
}): JSX.Element {
  const { summary, window, meta } = report;
  return (
    <div className="rounded-lg border border-ink-800 bg-ink-900/40 p-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col gap-2">
        <h3 className="text-lg font-semibold">
          Triage Report{" "}
          <span className="text-ink-500 font-normal">· {window}</span>
        </h3>
        <div className="flex flex-wrap gap-2">
          <Chip
            className="bg-red-500/15 text-red-300 border-red-500/40"
            label={`${summary.high} high`}
          />
          <Chip
            className="bg-amber-500/15 text-amber-300 border-amber-500/40"
            label={`${summary.med} med`}
          />
          <Chip
            className="bg-blue-500/15 text-blue-300 border-blue-500/40"
            label={`${summary.low} low`}
          />
          <Chip
            className="bg-ink-800 text-ink-200 border-ink-700"
            label={`total ${summary.total}`}
          />
        </div>
      </div>
      <div className="flex flex-col items-start sm:items-end gap-1 text-xs text-ink-400">
        <span className="font-mono">
          {meta.errorProvider} → {meta.sessionProvider}
        </span>
        <span>Took {formatDuration(meta.durationMs)}</span>
        {onReset ? (
          <button
            type="button"
            onClick={onReset}
            className="mt-2 rounded-md border border-ink-700 bg-ink-900/60 px-3 py-1.5 text-xs text-ink-200 hover:border-ink-500 transition-colors"
          >
            Run again
          </button>
        ) : null}
      </div>
    </div>
  );
}

function EmptyState({ window }: { window: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-dashed border-ink-700 bg-ink-900/40 p-10 text-center">
      <p className="text-sm text-ink-300">
        Nothing to triage in the {window}.
      </p>
      <p className="mt-1 text-xs text-ink-500">
        Either your providers are quiet, or your filter is too tight. Try a
        wider window.
      </p>
    </div>
  );
}

function IssueCard({
  issue,
  now,
}: {
  issue: TriageIssue;
  now: number;
}): JSX.Element {
  const tokens = SEVERITY[issue.severity];
  return (
    <article
      className={`rounded-lg border ${tokens.card} bg-ink-900/40 p-5 flex flex-col gap-4`}
    >
      <header className="flex flex-wrap items-start gap-3 justify-between">
        <div className="flex flex-col gap-2 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ${tokens.pill}`}
            >
              {issue.severity}
            </span>
            <span className="text-[11px] font-mono uppercase text-ink-500">
              {issue.provider}
            </span>
            {issue.environment ? (
              <span className="text-[11px] font-mono text-ink-500">
                env: {issue.environment}
              </span>
            ) : null}
            {issue.releaseVersion ? (
              <span className="text-[11px] font-mono text-ink-500">
                release: {issue.releaseVersion}
              </span>
            ) : null}
          </div>
          <h4 className="font-mono text-sm text-ink-100 break-words">
            {issue.title}
          </h4>
        </div>
        <span
          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${CONFIDENCE_PILL[issue.confidence]}`}
        >
          {CONFIDENCE_LABEL[issue.confidence]}
        </span>
      </header>

      <p className="text-xs text-ink-400">
        Affected {issue.affectedUsers.toLocaleString()} user
        {issue.affectedUsers === 1 ? "" : "s"} ·{" "}
        {issue.eventCount.toLocaleString()} event
        {issue.eventCount === 1 ? "" : "s"} · last {formatRelative(issue.lastSeen, now)}
      </p>

      <Block label="User flow" body={issue.userJourney} />
      <Block label="Hypothesis" body={issue.hypothesis} />
      <Block label="Root cause" body={issue.rootCauseGuess} />

      {issue.suggestedFiles.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-ink-500">
            Check
          </span>
          {issue.suggestedFiles.map((f) => (
            <code
              key={f}
              className="font-mono text-[11px] rounded bg-ink-950/60 border border-ink-800 px-1.5 py-0.5 text-ink-200"
            >
              {f}
            </code>
          ))}
        </div>
      ) : null}

      <footer className="flex flex-wrap items-center gap-3 pt-1">
        <a
          href={issue.sourceUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-xs text-brand-300 hover:text-brand-200 underline-offset-4 hover:underline"
        >
          Open in {capitalize(issue.provider)} ↗
        </a>
        {issue.replayUrl ? (
          <a
            href={issue.replayUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-xs text-brand-300 hover:text-brand-200 underline-offset-4 hover:underline"
          >
            Watch replay ↗
          </a>
        ) : null}
      </footer>
    </article>
  );
}

function Block({ label, body }: { label: string; body: string }): JSX.Element {
  return (
    <div>
      <span className="text-[11px] uppercase tracking-wider text-ink-500">
        {label}
      </span>
      <p className="mt-1 text-sm text-ink-200 leading-relaxed whitespace-pre-wrap">
        {body}
      </p>
    </div>
  );
}

function Chip({
  label,
  className,
}: {
  label: string;
  className: string;
}): JSX.Element {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${className}`}
    >
      {label}
    </span>
  );
}
