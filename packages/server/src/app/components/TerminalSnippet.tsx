/**
 * TerminalSnippet — stylised inline "terminal" code block with an embedded
 * {@link CopyButton}. Stays a server component; only the copy button is a
 * client island.
 *
 * The `lines` prop is the rendered text (typically prefixed with `$ `). The
 * `copyValue` prop is what actually lands on the clipboard — usually the same
 * lines without their `$ ` prompt prefixes.
 */

import { cn } from "@/lib/utils";

import { CopyButton } from "./CopyButton";

export interface TerminalSnippetProps {
  /** Lines rendered inside the `<pre>` block. */
  lines: readonly string[];
  /** Text written to the clipboard. Falls back to the rendered lines if omitted. */
  copyValue?: string;
  /** Accessible label for the copy button. */
  copyAriaLabel?: string;
  /** Extra classes for the outer wrapper. */
  className?: string;
}

export function TerminalSnippet({
  lines,
  copyValue,
  copyAriaLabel = "Copy command",
  className,
}: TerminalSnippetProps): JSX.Element {
  const rendered = lines.join("\n");
  const value = copyValue ?? rendered;
  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-lg border bg-muted text-left shadow-sm",
        className,
      )}
    >
      <pre className="overflow-x-auto px-4 py-3 pr-14 font-mono text-sm leading-relaxed text-foreground">
        <code>{rendered}</code>
      </pre>
      <div className="absolute right-2 top-1/2 -translate-y-1/2">
        <CopyButton
          value={value}
          ariaLabel={copyAriaLabel}
          size="icon"
          variant="ghost"
          className="h-8 w-8"
        />
      </div>
    </div>
  );
}
