"use client";

/**
 * Animated mock Slack channel showing the `/triage` lifecycle:
 * user types the slash command → bot acks with "Running triage…" →
 * placeholder is replaced by the full Block Kit triage card.
 *
 * Loops with a long pause on the final state so visitors actually have
 * time to read the report.
 */

import { useEffect, useRef, useState } from "react";
import { AlertOctagon, ExternalLink, Hash, Video } from "lucide-react";

type Phase =
  | "idle"
  | "typing"
  | "submitted"
  | "running"
  | "result"
  | "pause";

const NEXT_PHASE: Record<Phase, Phase> = {
  idle: "typing",
  typing: "submitted",
  submitted: "running",
  running: "result",
  result: "pause",
  pause: "idle",
};

const PHASE_DELAY_MS: Record<Phase, number> = {
  idle: 500,
  typing: 200, // computed dynamically per-char below
  submitted: 600,
  running: 1500,
  result: 6500,
  pause: 600,
};

const COMMAND = "/triage";
const TYPE_INTERVAL_MS = 90;

export function SlackAnimation(): JSX.Element {
  const [phase, setPhase] = useState<Phase>("idle");
  const [typedChars, setTypedChars] = useState(0);
  const typeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const phaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (phase === "typing" && typedChars < COMMAND.length) return;
    phaseTimer.current = setTimeout(() => {
      const next = NEXT_PHASE[phase];
      if (next === "typing") setTypedChars(0);
      setPhase(next);
    }, PHASE_DELAY_MS[phase]);
    return () => {
      if (phaseTimer.current) clearTimeout(phaseTimer.current);
    };
  }, [phase, typedChars]);

  useEffect(() => {
    if (phase !== "typing") return;
    if (typedChars >= COMMAND.length) return;
    typeTimer.current = setTimeout(
      () => setTypedChars((c) => c + 1),
      TYPE_INTERVAL_MS,
    );
    return () => {
      if (typeTimer.current) clearTimeout(typeTimer.current);
    };
  }, [phase, typedChars]);

  const showUserMessage =
    phase === "submitted" ||
    phase === "running" ||
    phase === "result" ||
    phase === "pause";
  const showRunning = phase === "running";
  const showResult = phase === "result" || phase === "pause";

  return (
    <div className="overflow-hidden rounded-xl border bg-white shadow-lg">
      {/* Channel header */}
      <div className="flex items-center gap-2 border-b bg-zinc-50 px-4 py-2.5">
        <Hash className="h-4 w-4 text-zinc-500" />
        <span className="text-sm font-semibold text-zinc-900">engineering</span>
        <span className="text-xs text-zinc-500">· 24 members</span>
      </div>

      <div className="min-h-[320px] space-y-3 px-4 py-4 text-sm">
        {showUserMessage ? (
          <SlackMessage author="kiran" authorColor="bg-purple-500">
            <span className="font-mono text-zinc-800">/triage</span>
          </SlackMessage>
        ) : null}

        {showRunning ? (
          <SlackMessage author="crashscope" authorColor="bg-orange-500" botBadge>
            <span className="text-zinc-700">
              <span className="inline-block animate-pulse">🔍</span> Running
              triage…
            </span>
          </SlackMessage>
        ) : null}

        {showResult ? (
          <SlackMessage author="crashscope" authorColor="bg-orange-500" botBadge>
            <TriageBlock />
          </SlackMessage>
        ) : null}

        {/* Bottom input bar */}
        <div className="!mt-6 rounded-md border bg-white px-3 py-2 shadow-inner">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-mono text-zinc-400">Message #engineering</span>
            {phase === "typing" || phase === "idle" ? (
              <span className="ml-auto font-mono text-zinc-700">
                {COMMAND.slice(0, typedChars)}
                <span className="ml-0.5 inline-block h-[14px] w-[6px] animate-pulse bg-zinc-700 align-middle" />
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

interface SlackMessageProps {
  author: string;
  authorColor: string;
  botBadge?: boolean;
  children: React.ReactNode;
}

function SlackMessage({
  author,
  authorColor,
  botBadge = false,
  children,
}: SlackMessageProps): JSX.Element {
  return (
    <div className="animate-[slideIn_300ms_ease-out] flex items-start gap-3">
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded text-xs font-bold uppercase text-white ${authorColor}`}
      >
        {author.charAt(0)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-bold text-zinc-900">{author}</span>
          {botBadge ? (
            <span className="rounded bg-zinc-200 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-zinc-700">
              APP
            </span>
          ) : null}
          <span className="text-xs text-zinc-400">just now</span>
        </div>
        <div className="mt-0.5">{children}</div>
      </div>
      <style>{`@keyframes slideIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }`}</style>
    </div>
  );
}

function TriageBlock(): JSX.Element {
  return (
    <div className="space-y-2 text-zinc-800">
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <span className="font-medium">Triage Report</span>
        <span>·</span>
        <span>last 24h · 7 issues</span>
      </div>
      <div className="rounded-md border border-red-200 bg-red-50/60 p-3">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-red-100 text-red-600">
            <AlertOctagon className="h-3.5 w-3.5" />
          </span>
          <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-red-700">
            High
          </span>
          <span className="font-mono text-[13px] font-semibold">
            TypeError in SupplementCard.tsx:42
          </span>
        </div>
        <div className="mt-1.5 pl-7 text-[12px] text-zinc-600">
          23 users · 47 events · last 1h
        </div>
        <div className="mt-2 pl-7 text-[12px] text-zinc-700">
          URL encoding fails on &ldquo;+&rdquo; in supplement names. Check{" "}
          <span className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px]">
            lib/scanner/parse.ts:18
          </span>
          .
        </div>
        <div className="mt-3 flex gap-2 pl-7">
          <span className="inline-flex items-center gap-1 rounded border bg-white px-2 py-1 text-[11px] text-zinc-700 shadow-sm">
            <Video className="h-3 w-3" />
            Watch replay
          </span>
          <span className="inline-flex items-center gap-1 rounded border bg-white px-2 py-1 text-[11px] text-zinc-700 shadow-sm">
            <ExternalLink className="h-3 w-3" />
            Open in Sentry
          </span>
        </div>
      </div>
      <div className="text-[11px] text-zinc-400">+ 2 high · 5 med · …</div>
    </div>
  );
}
