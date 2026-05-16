/**
 * "See it in action" section — two side-by-side animated demos showing the
 * CLI and the Slack bot flows. Both are React-only loops; no MP4s, no
 * external assets, theme-consistent with the rest of the page.
 */

import { SlackAnimation } from "./SlackAnimation";
import { TerminalAnimation } from "./TerminalAnimation";

export function Demos(): JSX.Element {
  return (
    <section id="see-it" className="border-b">
      <div className="mx-auto max-w-6xl px-6 py-16">
        <div className="text-center">
          <h2 className="text-3xl font-bold tracking-tight">See it in action</h2>
          <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">
            Same triage pipeline, two surfaces. Pick the one that fits how your
            team works.
          </p>
        </div>

        <div className="mt-12 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div>
            <div className="mb-3 flex items-center gap-2">
              <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                CLI
              </span>
              <span className="text-[11px] text-muted-foreground">
                · your terminal
              </span>
            </div>
            <TerminalAnimation />
          </div>
          <div>
            <div className="mb-3 flex items-center gap-2">
              <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                Slack
              </span>
              <span className="text-[11px] text-muted-foreground">
                · /triage in any channel
              </span>
            </div>
            <SlackAnimation />
          </div>
        </div>
      </div>
    </section>
  );
}
