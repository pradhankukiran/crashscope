"use client";

/**
 * Animated terminal showing a real-feeling `crashscope triage` run.
 *
 * Cycles through five phases: typing, fetch, match, investigate, report, then
 * pauses and loops. No real I/O — every line is canned for predictable timing
 * and offline rendering.
 */

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

const COMMAND = "crashscope triage --since=24h";

type Phase =
  | "idle"
  | "typing"
  | "fetching"
  | "matching"
  | "investigating"
  | "report"
  | "pause";

const NEXT_PHASE: Record<Phase, Phase> = {
  idle: "typing",
  typing: "fetching",
  fetching: "matching",
  matching: "investigating",
  investigating: "report",
  report: "pause",
  pause: "idle",
};

const PHASE_DELAY_MS: Record<Phase, number> = {
  idle: 600,
  typing: 200,
  fetching: 1100,
  matching: 1100,
  investigating: 1800,
  report: 5500,
  pause: 800,
};

const TYPE_INTERVAL_MS = 60;

interface ProgressLine {
  phase: Phase;
  label: string;
}

const PROGRESS: readonly ProgressLine[] = [
  { phase: "fetching", label: "Fetched 7 errors from sentry" },
  { phase: "matching", label: "Matched 7/7 sessions" },
  { phase: "investigating", label: "Investigated 7 issues" },
];

export function TerminalAnimation(): JSX.Element {
  const [phase, setPhase] = useState<Phase>("idle");
  const [typedChars, setTypedChars] = useState(0);
  const typeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const phaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Phase advancer (depends on phase only; types in a separate effect).
  useEffect(() => {
    if (phase === "typing" && typedChars < COMMAND.length) return;
    phaseTimer.current = setTimeout(() => {
      setPhase(NEXT_PHASE[phase]);
      if (NEXT_PHASE[phase] === "typing") setTypedChars(0);
    }, PHASE_DELAY_MS[phase]);
    return () => {
      if (phaseTimer.current) clearTimeout(phaseTimer.current);
    };
  }, [phase, typedChars]);

  // Type-out effect: only runs during the typing phase.
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

  const typed = COMMAND.slice(0, typedChars);
  const showProgress = phase !== "idle" && phase !== "typing";
  const showReport = phase === "report" || phase === "pause";

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 text-zinc-100 shadow-lg">
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-4 py-2.5">
        <span className="h-3 w-3 rounded-full bg-red-500/90" />
        <span className="h-3 w-3 rounded-full bg-yellow-500/90" />
        <span className="h-3 w-3 rounded-full bg-green-500/90" />
        <span className="ml-3 font-mono text-[11px] text-zinc-500">
          ~/crashscope · zsh
        </span>
      </div>

      <div className="min-h-[320px] px-5 py-4 font-mono text-[13px] leading-relaxed">
        <div className="flex items-center gap-2">
          <span className="text-emerald-400">❯</span>
          <span>{typed}</span>
          {phase === "typing" || phase === "idle" ? (
            <span className="ml-0.5 inline-block h-[14px] w-[7px] animate-pulse bg-zinc-300" />
          ) : null}
        </div>

        {showProgress ? (
          <div className="mt-3 space-y-1.5">
            {PROGRESS.map((line) => {
              const active = phase === line.phase;
              const done = phaseIndex(phase) > phaseIndex(line.phase);
              const shouldShow = active || done;
              if (!shouldShow) return null;
              return (
                <div
                  key={line.phase}
                  className={
                    done ? "text-emerald-400" : "text-zinc-200"
                  }
                >
                  {done ? (
                    <span className="mr-1.5">✓</span>
                  ) : (
                    <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin text-amber-400" />
                  )}
                  {line.label}
                </div>
              );
            })}
          </div>
        ) : null}

        {showReport ? <ReportPreview /> : null}
      </div>
    </div>
  );
}

function phaseIndex(p: Phase): number {
  return ["idle", "typing", "fetching", "matching", "investigating", "report", "pause"].indexOf(p);
}

function ReportPreview(): JSX.Element {
  return (
    <div className="mt-4 animate-[fadeIn_400ms_ease-out]">
      <div className="rounded-md border border-zinc-700/60 bg-zinc-900/60 p-3">
        <div className="text-center font-mono text-[11px] text-zinc-400">
          crashscope · last 24h · sentry → posthog · 7 issues
        </div>
      </div>

      <div className="mt-3 border-t border-zinc-800 pt-3">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-red-500/15 text-red-400">
            ●
          </span>
          <span className="rounded bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-red-300">
            High · fatal
          </span>
          <span className="text-zinc-300">
            TypeError in SupplementCard.tsx:42
          </span>
        </div>
        <div className="mt-1.5 pl-7 text-[12px] text-zinc-400">
          23 users · 47 events · last 1h
        </div>
        <div className="mt-3 grid gap-1 pl-7 text-[12px]">
          <div>
            <span className="text-zinc-500">User flow </span>
            <span className="text-zinc-300">
              Step 11 → add &ldquo;Vit D3 + K2&rdquo; → rage click ×4
            </span>
          </div>
          <div>
            <span className="text-zinc-500">Hypothesis </span>
            <span className="text-zinc-300">
              URL encoding fails on &ldquo;+&rdquo; in supplement names
            </span>
          </div>
          <div>
            <span className="text-zinc-500">Check </span>
            <span className="text-amber-300">lib/scanner/parse.ts:18</span>
          </div>
        </div>
      </div>

      <style>{`@keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }`}</style>
    </div>
  );
}
