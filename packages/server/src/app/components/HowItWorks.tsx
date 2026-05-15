/**
 * "How it works" section — four-step horizontal flow describing the pipeline
 * from error capture through to triage delivery.
 *
 * We use inline SVG glyphs rather than an icon library: it's a static page
 * with four icons; pulling in `lucide-react` (or similar) would dwarf the
 * page weight for no benefit.
 */

interface Step {
  index: number;
  title: string;
  body: string;
  icon: JSX.Element;
}

function ErrorIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6 text-brand-400" aria-hidden>
      <path
        d="M12 2 1 21h22L12 2Zm0 6v6m0 3.5v.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SessionIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6 text-brand-400" aria-hidden>
      <rect x="2" y="5" width="20" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="m10 9 6 3-6 3V9Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ClaudeIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6 text-brand-400" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M8 13c1 1.5 2.5 2 4 2s3-.5 4-2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="9" cy="10" r="1" fill="currentColor" />
      <circle cx="15" cy="10" r="1" fill="currentColor" />
    </svg>
  );
}

function ReportIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6 text-brand-400" aria-hidden>
      <path
        d="M5 4h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M9 12h6M9 16h6M9 8h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

const STEPS: Step[] = [
  {
    index: 1,
    title: "Fetch errors",
    body: "Pull recent issues from Sentry, Rollbar, Bugsnag, or Honeybadger.",
    icon: <ErrorIcon />,
  },
  {
    index: 2,
    title: "Find the session",
    body: "Match each affected user to a PostHog or LogRocket session.",
    icon: <SessionIcon />,
  },
  {
    index: 3,
    title: "Investigate",
    body: "Claude analyses the stack + user journey and emits a structured finding.",
    icon: <ClaudeIcon />,
  },
  {
    index: 4,
    title: "Deliver",
    body: "Report goes to Slack, your terminal, or your API consumer.",
    icon: <ReportIcon />,
  },
];

export function HowItWorks(): JSX.Element {
  return (
    <section id="how-it-works" className="border-b border-ink-800">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <h2 className="text-3xl font-bold tracking-tight text-center">
          How it works
        </h2>
        <p className="mt-3 text-center text-ink-400 max-w-2xl mx-auto">
          A deterministic adapter layer feeds a Claude investigation, so the
          model gets just the signals it needs — no provider-specific prompts.
        </p>
        <ol className="mt-12 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {STEPS.map((s) => (
            <li
              key={s.index}
              className="rounded-lg border border-ink-800 bg-ink-900/40 p-6"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono text-ink-500">
                  STEP {s.index.toString().padStart(2, "0")}
                </span>
                {s.icon}
              </div>
              <h3 className="mt-4 text-lg font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm text-ink-400 leading-relaxed">
                {s.body}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
