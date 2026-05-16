"use client";

/**
 * Animated mock Slack channel cycling through realistic crashscope bot
 * interactions: vanilla `/triage`, filtered runs, a clean-window response,
 * an unprompted morning digest, and a help command. Each scene types a
 * different slash command (or skips the user message entirely for the
 * unprompted post) and renders an output appropriate to the request.
 */

import { type ReactNode, useEffect, useRef, useState } from "react";
import { AlertOctagon, ExternalLink, Hash, Video } from "lucide-react";

type Phase = "type" | "user" | "load" | "result" | "pause";

const TYPE_INTERVAL_MS = 65;
const USER_HOLD_MS = 500;
const LOAD_HOLD_MS = 1200;
const RESULT_HOLD_MS = 5500;
const PAUSE_BETWEEN_SCENES_MS = 600;

interface SlackScene {
  /** What the user types into the slash-command input. Omit for unprompted bot posts. */
  user?: string;
  /** Optional loading message the bot acks with. Omit to skip the loading step. */
  loading?: string;
  /** Final rendered bot response. */
  result: ReactNode;
}

const SCENES: readonly SlackScene[] = [
  {
    user: "/triage",
    loading: "🔍 Running triage…",
    result: <FullTriageReport />,
  },
  {
    user: "/triage severity=fatal,error since=7d",
    loading: "🔍 Running filtered triage…",
    result: <FilteredTriageReport />,
  },
  {
    user: "/triage 1h",
    loading: "🔍 Running triage…",
    result: <CleanWindowReport />,
  },
  {
    // Unprompted scheduled post
    result: <MorningDigest />,
  },
  {
    user: "/triage help",
    result: <HelpMessage />,
  },
];

export function SlackAnimation(): JSX.Element {
  const [sceneIdx, setSceneIdx] = useState(0);
  const [phase, setPhase] = useState<Phase>("type");
  const [typedChars, setTypedChars] = useState(0);

  const typeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const phaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scene = SCENES[sceneIdx]!;
  const command = scene.user ?? "";

  // Pick the first valid phase for the current scene the first time we enter it.
  useEffect(() => {
    if (!scene.user) setPhase((p) => (p === "type" ? "result" : p));
    else if (!scene.loading && phase === "load") setPhase("result");
    // Intentionally not depending on phase here; we only adjust on scene change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneIdx]);

  // Typing
  useEffect(() => {
    if (phase !== "type") return;
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
    if (phase === "type" && typedChars < command.length) return;

    let delay: number;
    switch (phase) {
      case "type":
        delay = 350;
        break;
      case "user":
        delay = USER_HOLD_MS;
        break;
      case "load":
        delay = LOAD_HOLD_MS;
        break;
      case "result":
        delay = RESULT_HOLD_MS;
        break;
      case "pause":
        delay = PAUSE_BETWEEN_SCENES_MS;
        break;
    }

    phaseTimer.current = setTimeout(() => {
      const next = nextPhase(phase, scene);
      if (next === "type") {
        // Moving to the next scene.
        const nextIdx = (sceneIdx + 1) % SCENES.length;
        setSceneIdx(nextIdx);
        setTypedChars(0);
        const nextScene = SCENES[nextIdx]!;
        setPhase(nextScene.user ? "type" : "result");
      } else {
        setPhase(next);
      }
    }, delay);

    return () => {
      if (phaseTimer.current) clearTimeout(phaseTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, typedChars, command.length, sceneIdx]);

  const showUserMessage =
    !!scene.user && (phase === "user" || phase === "load" || phase === "result" || phase === "pause");
  const showLoading = phase === "load" && !!scene.loading;
  const showResult = phase === "result" || phase === "pause";
  const showTyping = phase === "type";

  return (
    <div className="overflow-hidden rounded-xl border bg-white shadow-lg">
      {/* Channel header */}
      <div className="flex items-center gap-2 border-b bg-zinc-50 px-4 py-2.5">
        <Hash className="h-4 w-4 text-zinc-500" />
        <span className="text-sm font-semibold text-zinc-900">engineering</span>
        <span className="text-xs text-zinc-500">· 24 members</span>
      </div>

      <div className="min-h-[340px] space-y-3 px-4 py-4 text-sm">
        {showUserMessage ? (
          <SlackMessage author="kiran" authorColor="bg-purple-500">
            <span className="font-mono text-zinc-800">{scene.user}</span>
          </SlackMessage>
        ) : null}

        {showLoading ? (
          <SlackMessage author="crashscope" authorColor="bg-orange-500" botBadge>
            <span className="text-zinc-700">{scene.loading}</span>
          </SlackMessage>
        ) : null}

        {showResult ? (
          <SlackMessage
            key={sceneIdx}
            author="crashscope"
            authorColor="bg-orange-500"
            botBadge
          >
            {scene.result}
          </SlackMessage>
        ) : null}

        {/* Bottom input bar */}
        <div className="!mt-6 rounded-md border bg-white px-3 py-2 shadow-inner">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-mono text-zinc-400">Message #engineering</span>
            {showTyping ? (
              <span className="ml-auto font-mono text-zinc-700">
                {command.slice(0, typedChars)}
                <span className="ml-0.5 inline-block h-[14px] w-[6px] animate-pulse bg-zinc-700 align-middle" />
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function nextPhase(phase: Phase, scene: SlackScene): Phase {
  switch (phase) {
    case "type":
      return "user";
    case "user":
      return scene.loading ? "load" : "result";
    case "load":
      return "result";
    case "result":
      return "pause";
    case "pause":
      return "type";
  }
}

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Bot response renderers                                              */
/* ------------------------------------------------------------------ */

function IssueCard({
  severity,
  title,
  affected,
  body,
  withActions = true,
}: {
  severity: "high" | "med";
  title: string;
  affected: string;
  body: ReactNode;
  withActions?: boolean;
}): JSX.Element {
  const tint =
    severity === "high"
      ? {
          border: "border-red-200",
          bg: "bg-red-50/60",
          chipBg: "bg-red-100",
          chipText: "text-red-700",
          icon: "bg-red-100 text-red-600",
        }
      : {
          border: "border-amber-200",
          bg: "bg-amber-50/60",
          chipBg: "bg-amber-100",
          chipText: "text-amber-700",
          icon: "bg-amber-100 text-amber-600",
        };

  return (
    <div className={`rounded-md border ${tint.border} ${tint.bg} p-3`}>
      <div className="flex items-center gap-2">
        <span className={`inline-flex h-5 w-5 items-center justify-center rounded-md ${tint.icon}`}>
          <AlertOctagon className="h-3.5 w-3.5" />
        </span>
        <span className={`rounded ${tint.chipBg} px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${tint.chipText}`}>
          {severity === "high" ? "High" : "Med"}
        </span>
        <span className="font-mono text-[13px] font-semibold">{title}</span>
      </div>
      <div className="mt-1.5 pl-7 text-[12px] text-zinc-600">{affected}</div>
      <div className="mt-2 pl-7 text-[12px] text-zinc-700">{body}</div>
      {withActions ? (
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
      ) : null}
    </div>
  );
}

function FullTriageReport(): JSX.Element {
  return (
    <div className="space-y-2 text-zinc-800">
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <span className="font-medium">Triage Report</span>
        <span>·</span>
        <span>last 24h · 7 issues</span>
      </div>
      <IssueCard
        severity="high"
        title="TypeError in SupplementCard.tsx:42"
        affected="23 users · 47 events · last 1h"
        body={
          <>
            URL encoding fails on &ldquo;+&rdquo; in supplement names. Check{" "}
            <span className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px]">
              lib/scanner/parse.ts:18
            </span>
            .
          </>
        }
      />
      <div className="text-[11px] text-zinc-400">+ 2 high · 4 med · …</div>
    </div>
  );
}

function FilteredTriageReport(): JSX.Element {
  return (
    <div className="space-y-2 text-zinc-800">
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <span className="font-medium">Triage Report</span>
        <span>·</span>
        <span>severity:fatal,error · last 7d · 2 issues</span>
      </div>
      <IssueCard
        severity="high"
        title="Unhandled rejection · checkout.ts:88"
        affected="12 users · 18 events · last 2h"
        body="payments-service throws on retry when idempotency-key collides."
      />
      <IssueCard
        severity="high"
        title="OOMKilled · queue-runner-7c8b"
        affected="pod restart · 3× in last 24h"
        body="kubernetes evicted the worker. Suggest bumping memory limit or chunking imports."
        withActions={false}
      />
    </div>
  );
}

function CleanWindowReport(): JSX.Element {
  return (
    <div className="space-y-2 text-zinc-800">
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <span className="font-medium">Triage Report</span>
        <span>·</span>
        <span>last 1h · 0 issues</span>
      </div>
      <div className="rounded-md border border-emerald-200 bg-emerald-50/60 p-4 text-center">
        <div className="text-2xl">✨</div>
        <div className="mt-1 text-sm font-semibold text-emerald-700">
          No issues in the last hour.
        </div>
        <div className="mt-1 text-[12px] text-zinc-600">
          Your users are having a fine time. Carry on.
        </div>
      </div>
    </div>
  );
}

function MorningDigest(): JSX.Element {
  return (
    <div className="space-y-2 text-zinc-800">
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <span>☕</span>
        <span className="font-medium">Morning digest</span>
        <span>·</span>
        <span>posted by schedule · last 24h</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-md border bg-red-50 px-3 py-2 text-center">
          <div className="text-lg font-bold text-red-700">3</div>
          <div className="text-[10px] uppercase tracking-wider text-red-600">
            high
          </div>
        </div>
        <div className="rounded-md border bg-amber-50 px-3 py-2 text-center">
          <div className="text-lg font-bold text-amber-700">5</div>
          <div className="text-[10px] uppercase tracking-wider text-amber-600">
            med
          </div>
        </div>
        <div className="rounded-md border bg-sky-50 px-3 py-2 text-center">
          <div className="text-lg font-bold text-sky-700">2</div>
          <div className="text-[10px] uppercase tracking-wider text-sky-600">
            low
          </div>
        </div>
      </div>
      <div className="rounded-md bg-zinc-50 p-2.5 text-[12px] text-zinc-700">
        Top: TypeError in <span className="font-mono">SupplementCard.tsx</span>{" "}
        (23 users) · new since deploy <span className="font-mono">v2.3.1</span>.
      </div>
    </div>
  );
}

function HelpMessage(): JSX.Element {
  const Row = ({ cmd, desc }: { cmd: string; desc: string }): JSX.Element => (
    <div className="flex items-baseline gap-3 text-[12px]">
      <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-zinc-800">
        {cmd}
      </span>
      <span className="text-zinc-600">{desc}</span>
    </div>
  );

  return (
    <div className="space-y-1.5 text-zinc-800">
      <div className="text-[12px] font-medium text-zinc-700">
        crashscope · usage
      </div>
      <Row cmd="/triage" desc="run on the last 24h" />
      <Row cmd="/triage 7d" desc="custom window (1h, 6h, 24h, 7d, 14d, 30d)" />
      <Row cmd="/triage severity=fatal,error" desc="filter by severity" />
      <Row cmd="/triage help" desc="show this message" />
      <div className="!mt-2 text-[11px] text-zinc-500">
        Scheduled digests post automatically at 9am UTC on weekdays.
      </div>
    </div>
  );
}
