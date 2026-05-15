/**
 * QuickStart — three side-by-side code blocks (CLI, Slack, API) so visitors
 * can see how to invoke crashscope from any of the supported surfaces.
 *
 * We deliberately keep this as plain `<pre>` blocks rather than a JS-driven
 * tab switcher; the page is a marketing surface and all three modes fit
 * comfortably on desktop. On mobile they stack.
 */

interface Snippet {
  label: string;
  language: string;
  code: string;
  blurb: string;
}

const SNIPPETS: Snippet[] = [
  {
    label: "CLI",
    language: "bash",
    code:
      "$ npm i -g crashscope\n" +
      "$ crashscope init\n" +
      "$ crashscope triage --since 24h",
    blurb:
      "Install once, configure your providers interactively, then triage from any terminal.",
  },
  {
    label: "Slack",
    language: "text",
    code:
      "/triage\n" +
      "/triage 7d\n" +
      "/triage 24h severity=fatal,error",
    blurb:
      "Add the Slack app, mount this server, and `/triage` from any channel.",
  },
  {
    label: "API",
    language: "bash",
    code:
      "$ curl -H 'Authorization: Bearer $TOKEN' \\\n" +
      "       'https://your.vercel.app/api/triage?since=24h&limit=25'",
    blurb:
      "Hit the REST endpoint from CI, internal dashboards, or your own bot.",
  },
];

export function QuickStart(): JSX.Element {
  return (
    <section id="quick-start" className="border-b border-ink-800">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <h2 className="text-3xl font-bold tracking-tight text-center">
          Three surfaces, one pipeline
        </h2>
        <p className="mt-3 text-center text-ink-400 max-w-2xl mx-auto">
          The same triage pipeline backs the CLI, the Slack bot, and the REST
          API. Pick whichever surface fits your workflow.
        </p>
        <div className="mt-12 grid grid-cols-1 lg:grid-cols-3 gap-6">
          {SNIPPETS.map((s) => (
            <div
              key={s.label}
              className="flex flex-col rounded-lg border border-ink-800 bg-ink-900/40 overflow-hidden"
            >
              <div className="border-b border-ink-800 px-4 py-2 flex items-center justify-between">
                <span className="text-sm font-semibold">{s.label}</span>
                <span className="text-[10px] font-mono uppercase text-ink-500">
                  {s.language}
                </span>
              </div>
              <pre className="code-block flex-1 m-0 rounded-none border-0">
                <code>{s.code}</code>
              </pre>
              <div className="px-4 py-3 border-t border-ink-800 text-xs text-ink-400">
                {s.blurb}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
