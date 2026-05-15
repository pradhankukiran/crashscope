/**
 * Top-of-page marketing hero.
 *
 * Renders the headline, sub-headline, and the two primary CTAs (Deploy to
 * Vercel + GitHub). Kept as a server component — there's no client state.
 */

const DEPLOY_URL =
  "https://vercel.com/new/clone?repository-url=" +
  encodeURIComponent(
    "https://github.com/crashscope/crashscope/tree/main/packages/server",
  );

const GITHUB_URL = "https://github.com/crashscope/crashscope";

export function Hero(): JSX.Element {
  return (
    <section className="relative overflow-hidden border-b border-ink-800">
      <div className="absolute inset-0 bg-gradient-radial pointer-events-none" />
      <div className="relative mx-auto max-w-6xl px-6 py-24 sm:py-32 text-center">
        <p className="inline-flex items-center gap-2 rounded-full border border-ink-800 bg-ink-900/60 px-3 py-1 text-xs text-brand-300">
          <span aria-hidden>{`>`}</span>
          <span>AI triage that knows what the user did before the crash</span>
        </p>
        <h1 className="mt-6 text-4xl sm:text-6xl font-bold tracking-tight bg-gradient-to-b from-white to-ink-300 bg-clip-text text-transparent">
          AI-powered error triage
          <br className="hidden sm:block" />
          for your stack.
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-base sm:text-lg text-ink-300">
          Crashscope joins your error tracker with session replay and uses
          Claude to produce ranked, actionable triage reports — for Slack, the
          CLI, or your own automation via REST.
        </p>
        <div className="mt-10 flex flex-col sm:flex-row gap-3 justify-center">
          <a
            href={DEPLOY_URL}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-brand-500 px-5 py-3 text-sm font-medium text-ink-950 hover:bg-brand-400 transition-colors"
          >
            <span aria-hidden>{"▲"}</span>
            Deploy to Vercel
          </a>
          <a
            href={GITHUB_URL}
            className="inline-flex items-center justify-center gap-2 rounded-md border border-ink-700 bg-ink-900/60 px-5 py-3 text-sm font-medium text-ink-100 hover:border-ink-500 transition-colors"
          >
            View on GitHub
          </a>
        </div>
        <p className="mt-6 text-xs text-ink-500">
          Bring your own Anthropic API key. No data ever leaves your providers
          beyond what you authorize.
        </p>
      </div>
    </section>
  );
}
