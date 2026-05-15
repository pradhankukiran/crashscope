/**
 * Adapter matrix — a grid of cards advertising the four error trackers and
 * two session-replay providers crashscope supports out of the box.
 *
 * Each card has the provider name, role, and a `status` line; we keep them
 * label-only (no logos) to avoid the legal complications of redistributing
 * third-party trademarks inside the package.
 */

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
  const label = role === "error" ? "Error tracker" : "Session replay";
  const colour =
    role === "error"
      ? "bg-red-500/10 text-red-300 border-red-500/30"
      : "bg-cyan-500/10 text-cyan-300 border-cyan-500/30";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${colour}`}
    >
      {label}
    </span>
  );
}

export function AdapterMatrix(): JSX.Element {
  return (
    <section id="adapters" className="border-b border-ink-800">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <h2 className="text-3xl font-bold tracking-tight text-center">
          Bring your existing stack
        </h2>
        <p className="mt-3 text-center text-ink-400 max-w-2xl mx-auto">
          Adapters live in <code className="text-brand-300">@crashscope/core</code>{" "}
          and normalize each provider into a shared error and session shape.
        </p>
        <div className="mt-12 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {ADAPTERS.map((a) => (
            <div
              key={a.name}
              className="rounded-lg border border-ink-800 bg-ink-900/40 p-5 hover:border-ink-600 transition-colors"
            >
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-lg font-semibold">{a.name}</h3>
                <RoleBadge role={a.role} />
              </div>
              <p className="mt-3 text-sm text-ink-400 leading-relaxed">
                {a.blurb}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
