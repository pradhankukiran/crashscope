/**
 * Page footer — minimal colophon + link list. Server component, no state.
 */

const LINKS: ReadonlyArray<{ label: string; href: string }> = [
  { label: "GitHub", href: "https://github.com/crashscope/crashscope" },
  { label: "API", href: "/api/health" },
  { label: "Docs", href: "https://github.com/crashscope/crashscope#readme" },
];

export function Footer(): JSX.Element {
  return (
    <footer className="border-t">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-10 text-sm text-muted-foreground sm:flex-row">
        <p>
          Crashscope is open source.{" "}
          <span className="text-foreground">
            Built on @crashscope/core + Anthropic Claude.
          </span>
        </p>
        <nav className="flex gap-5">
          {LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="transition-colors hover:text-foreground"
            >
              {l.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}
