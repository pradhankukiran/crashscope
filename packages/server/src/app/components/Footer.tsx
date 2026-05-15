/**
 * Page footer: minimal links + colophon. Server component, no client state.
 */

const LINKS: Array<{ label: string; href: string }> = [
  { label: "GitHub", href: "https://github.com/crashscope/crashscope" },
  { label: "API", href: "/api/health" },
  { label: "Docs", href: "https://github.com/crashscope/crashscope#readme" },
];

export function Footer(): JSX.Element {
  return (
    <footer className="border-t border-ink-800">
      <div className="mx-auto max-w-6xl px-6 py-10 flex flex-col sm:flex-row gap-4 items-center justify-between text-sm text-ink-500">
        <p>
          Crashscope is open source.{" "}
          <span className="text-ink-400">
            Built on @crashscope/core + Anthropic Claude.
          </span>
        </p>
        <nav className="flex gap-5">
          {LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="hover:text-ink-100 transition-colors"
            >
              {l.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}
