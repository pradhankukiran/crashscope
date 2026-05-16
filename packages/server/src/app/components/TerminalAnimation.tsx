"use client";

/**
 * Animated terminal cycling through realistic `crashscope` invocations.
 *
 * Each scene types a different command and renders a different shape of
 * output: the main triage report, a filtered run, JSON piped to jq, a file
 * write, a config dump, an init wizard step, and dry-run pricing. Loops
 * forever with a pause between scenes.
 */

import { type ReactNode, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

type Phase = "typing" | "running" | "pause";

const TYPE_INTERVAL_MS = 55;
const RUNNING_HOLD_MS = 4500;
const PAUSE_BETWEEN_SCENES_MS = 700;

interface Scene {
  command: string;
  render: () => ReactNode;
}

const SCENES: readonly Scene[] = [
  {
    command: "crashscope triage --since=24h",
    render: () => <TriageScene />,
  },
  {
    command: "crashscope triage --severity=fatal --since=7d",
    render: () => <FilteredScene />,
  },
  {
    command: "crashscope triage --json | jq '.summary'",
    render: () => <JsonScene />,
  },
  {
    command: "crashscope triage --out triage.md",
    render: () => <FileWriteScene />,
  },
  {
    command: "crashscope triage --dry-run",
    render: () => <DryRunScene />,
  },
  {
    command: "crashscope config show",
    render: () => <ConfigShowScene />,
  },
  {
    command: "crashscope init",
    render: () => <InitScene />,
  },
];

export function TerminalAnimation(): JSX.Element {
  const [sceneIdx, setSceneIdx] = useState(0);
  const [phase, setPhase] = useState<Phase>("typing");
  const [typedChars, setTypedChars] = useState(0);

  const typeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const phaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scene = SCENES[sceneIdx]!;
  const command = scene.command;

  // Type-out
  useEffect(() => {
    if (phase !== "typing") return;
    if (typedChars >= command.length) return;
    typeTimer.current = setTimeout(() => {
      setTypedChars((c) => c + 1);
    }, TYPE_INTERVAL_MS);
    return () => {
      if (typeTimer.current) clearTimeout(typeTimer.current);
    };
  }, [phase, typedChars, command.length]);

  // Phase advancer
  useEffect(() => {
    if (phase === "typing" && typedChars < command.length) return;
    let delay: number;
    if (phase === "typing") delay = 400;
    else if (phase === "running") delay = RUNNING_HOLD_MS;
    else delay = PAUSE_BETWEEN_SCENES_MS;

    phaseTimer.current = setTimeout(() => {
      if (phase === "typing") setPhase("running");
      else if (phase === "running") setPhase("pause");
      else {
        const next = (sceneIdx + 1) % SCENES.length;
        setSceneIdx(next);
        setTypedChars(0);
        setPhase("typing");
      }
    }, delay);

    return () => {
      if (phaseTimer.current) clearTimeout(phaseTimer.current);
    };
  }, [phase, typedChars, command.length, sceneIdx]);

  const showOutput = phase === "running" || phase === "pause";
  const showCursor = phase === "typing";

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 text-zinc-100 shadow-lg">
      {/* Window chrome */}
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-4 py-2.5">
        <span className="h-3 w-3 rounded-full bg-red-500/90" />
        <span className="h-3 w-3 rounded-full bg-yellow-500/90" />
        <span className="h-3 w-3 rounded-full bg-green-500/90" />
        <span className="ml-3 font-mono text-[11px] text-zinc-500">
          ~/crashscope · zsh
        </span>
      </div>

      <div className="min-h-[340px] px-5 py-4 font-mono text-[13px] leading-relaxed">
        <div className="flex items-center gap-2">
          <span className="text-emerald-400">❯</span>
          <span>{command.slice(0, typedChars)}</span>
          {showCursor ? (
            <span className="ml-0.5 inline-block h-[14px] w-[7px] animate-pulse bg-zinc-300" />
          ) : null}
        </div>

        {showOutput ? (
          <div key={sceneIdx} className="mt-3 animate-[fadeIn_400ms_ease-out]">
            {scene.render()}
          </div>
        ) : null}
      </div>

      <style>{`@keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }`}</style>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Scenes                                                              */
/* ------------------------------------------------------------------ */

function TriageScene(): JSX.Element {
  return (
    <>
      <ProgressLines
        lines={[
          "Fetched 7 errors from sentry",
          "Matched 7/7 sessions",
          "Investigated 7 issues",
        ]}
      />
      <SummaryBox subtitle="sentry → posthog · 7 issues" />
      <div className="mt-3 border-t border-zinc-800 pt-3">
        <IssueLine severity="high" file="TypeError in SupplementCard.tsx:42" />
        <div className="mt-1 pl-7 text-[12px] text-zinc-400">
          23 users · 47 events · last 1h
        </div>
        <div className="mt-2 grid gap-0.5 pl-7 text-[12px]">
          <KV k="Hypothesis" v={`URL encoding fails on "+" in supplement names`} />
          <KV k="Check" v="lib/scanner/parse.ts:18" amber />
        </div>
      </div>
      <div className="mt-3 pl-7 text-[11px] text-zinc-500">
        Summary: 7 issues · 3 high · 3 med · 1 low · 47s
      </div>
    </>
  );
}

function FilteredScene(): JSX.Element {
  return (
    <>
      <ProgressLines
        lines={[
          "Fetched 2 errors from sentry",
          "Matched 2/2 sessions",
          "Investigated 2 issues",
        ]}
      />
      <SummaryBox subtitle="severity:fatal · last 7d · 2 issues" />
      <div className="mt-3 space-y-2 border-t border-zinc-800 pt-3">
        <IssueLine
          severity="high"
          file="Unhandled rejection · payments-service:checkout.ts:88"
        />
        <IssueLine
          severity="high"
          file="OOMKilled · worker pod 'queue-runner-7c8b' (kubernetes)"
        />
      </div>
    </>
  );
}

function JsonScene(): JSX.Element {
  return (
    <pre className="overflow-x-auto whitespace-pre rounded-md border border-zinc-800 bg-zinc-900/40 p-3 text-[12px] text-zinc-200">
      <span className="text-zinc-500">{`{`}</span>
      {"\n"}
      {"  "}
      <span className="text-sky-400">{`"window"`}</span>
      <span className="text-zinc-500">: </span>
      <span className="text-emerald-400">{`"last 24h"`}</span>
      <span className="text-zinc-500">,</span>
      {"\n"}
      {"  "}
      <span className="text-sky-400">{`"high"`}</span>
      <span className="text-zinc-500">: </span>
      <span className="text-amber-300">3</span>
      <span className="text-zinc-500">,</span>
      {"\n"}
      {"  "}
      <span className="text-sky-400">{`"med"`}</span>
      <span className="text-zinc-500">: </span>
      <span className="text-amber-300">3</span>
      <span className="text-zinc-500">,</span>
      {"\n"}
      {"  "}
      <span className="text-sky-400">{`"low"`}</span>
      <span className="text-zinc-500">: </span>
      <span className="text-amber-300">1</span>
      <span className="text-zinc-500">,</span>
      {"\n"}
      {"  "}
      <span className="text-sky-400">{`"total"`}</span>
      <span className="text-zinc-500">: </span>
      <span className="text-amber-300">7</span>
      {"\n"}
      <span className="text-zinc-500">{`}`}</span>
    </pre>
  );
}

function FileWriteScene(): JSX.Element {
  return (
    <>
      <ProgressLines
        lines={[
          "Fetched 7 errors from sentry",
          "Matched 7/7 sessions",
          "Investigated 7 issues",
        ]}
      />
      <div className="mt-3 rounded-md border border-emerald-700/50 bg-emerald-950/40 p-3">
        <div className="flex items-center gap-2 text-emerald-300">
          <span>✓</span>
          <span className="text-sm">Wrote 7 issues to</span>
          <span className="rounded bg-emerald-900/60 px-1.5 py-0.5 font-mono text-[12px] text-emerald-200">
            triage.md
          </span>
        </div>
        <div className="mt-1 pl-6 text-[12px] text-zinc-400">
          12.4 KB · markdown · ready to paste into Linear / GitHub
        </div>
      </div>
    </>
  );
}

function DryRunScene(): JSX.Element {
  return (
    <>
      <div className="flex items-center gap-2 text-amber-300">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>Dry-run: skipping Claude investigation</span>
      </div>
      <div className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
        <span className="text-zinc-500">sentry</span>
        <span>7 errors fetched</span>
        <span className="text-zinc-500">posthog</span>
        <span>7 sessions matched</span>
        <span className="text-zinc-500">claude</span>
        <span className="text-amber-300">
          would investigate 7 issues · ~$0.42 estimated · skipped
        </span>
      </div>
      <div className="mt-3 text-[11px] text-zinc-500">
        Use without --dry-run to actually triage.
      </div>
    </>
  );
}

function ConfigShowScene(): JSX.Element {
  return (
    <pre className="overflow-x-auto whitespace-pre rounded-md border border-zinc-800 bg-zinc-900/40 p-3 text-[12px] text-zinc-200">
      <span className="text-zinc-500"># ~/.crashscope/config.json (0600)</span>
      {"\n"}
      <span className="text-sky-400">errorProvider</span>:{" "}
      <span className="text-emerald-300">sentry</span>
      {"\n"}
      <span className="text-sky-400">sessionProvider</span>:{" "}
      <span className="text-emerald-300">posthog</span>
      {"\n"}
      <span className="text-sky-400">outputs</span>:{" "}
      <span className="text-emerald-300">[terminal, slack]</span>
      {"\n"}
      <span className="text-sky-400">credentials</span>:
      {"\n  "}
      <span className="text-sky-400">sentry</span>:{" "}
      <span className="text-zinc-400">{`{ token: sntrys_***1a2b, org: acme, project: web }`}</span>
      {"\n  "}
      <span className="text-sky-400">posthog</span>:{" "}
      <span className="text-zinc-400">{`{ apiKey: phx_***7c8d, projectId: 12345 }`}</span>
    </pre>
  );
}

function InitScene(): JSX.Element {
  return (
    <div className="space-y-2 text-[13px]">
      <div className="text-zinc-300">Welcome to crashscope.</div>
      <div>
        <span className="text-sky-300">?</span> Which error tracker do you use?{" "}
        <span className="font-bold text-emerald-300">Sentry</span>
      </div>
      <div>
        <span className="text-sky-300">?</span> Sentry auth token:{" "}
        <span className="text-zinc-400">sntrys_••••••••••</span>{" "}
        <span className="text-emerald-300">✓ validated</span>
      </div>
      <div>
        <span className="text-sky-300">?</span> Which session tool do you use?{" "}
        <span className="font-bold text-emerald-300">PostHog</span>
      </div>
      <div>
        <span className="text-emerald-300">✓</span> Detected Claude Code
        subscription (using this by default)
      </div>
      <div>
        <span className="text-emerald-300">✓</span> Config saved to{" "}
        <span className="text-zinc-300">~/.crashscope/config.json</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

function ProgressLines({ lines }: { lines: readonly string[] }): JSX.Element {
  return (
    <div className="space-y-1 text-[13px]">
      {lines.map((label) => (
        <div key={label} className="text-emerald-400">
          <span className="mr-1.5">✓</span>
          <span className="text-zinc-200">{label}</span>
        </div>
      ))}
    </div>
  );
}

function SummaryBox({ subtitle }: { subtitle: string }): JSX.Element {
  return (
    <div className="mt-3 rounded-md border border-zinc-700/60 bg-zinc-900/60 p-2.5 text-center font-mono text-[11px] text-zinc-400">
      crashscope · {subtitle}
    </div>
  );
}

interface IssueLineProps {
  severity: "high" | "med" | "low";
  file: string;
}

function IssueLine({ severity, file }: IssueLineProps): JSX.Element {
  const tint =
    severity === "high"
      ? "bg-red-500/15 text-red-300"
      : severity === "med"
        ? "bg-amber-500/15 text-amber-300"
        : "bg-sky-500/15 text-sky-300";
  return (
    <div className="flex items-center gap-2">
      <span
        className={`inline-flex h-5 items-center justify-center rounded px-1.5 text-[10px] font-semibold uppercase tracking-wider ${tint}`}
      >
        {severity}
      </span>
      <span className="text-zinc-200">{file}</span>
    </div>
  );
}

function KV({
  k,
  v,
  amber = false,
}: {
  k: string;
  v: string;
  amber?: boolean;
}): JSX.Element {
  return (
    <div>
      <span className="text-zinc-500">{k}</span>{" "}
      <span className={amber ? "text-amber-300" : "text-zinc-300"}>{v}</span>
    </div>
  );
}
