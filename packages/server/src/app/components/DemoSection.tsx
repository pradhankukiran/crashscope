"use client";

/**
 * DemoSection — the "Try it now" block that glues {@link DemoForm} and
 * {@link TriageResults} together on the landing page.
 *
 * Owns the transient state (last report, last error, run telemetry) so the
 * surrounding page can stay a server component. The triage run itself happens
 * inside `DemoForm`; this component only routes the callbacks.
 *
 * On a successful run we auto-scroll to the results area so visitors don't
 * have to hunt for it on long pages. The scroll is throttled to once per
 * report via the `report` dependency.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { TriageReport } from "@crashscope/core";
import { DemoForm } from "./DemoForm";
import { TriageResults } from "./TriageResults";

export function DemoSection(): JSX.Element {
  const [report, setReport] = useState<TriageReport | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to results when a new report lands.
  useEffect(() => {
    if (report && resultsRef.current) {
      resultsRef.current.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }
  }, [report]);

  const handleResult = useCallback((next: TriageReport) => {
    setErrorMessage(null);
    setReport(next);
  }, []);

  const handleError = useCallback((message: string) => {
    setErrorMessage(message);
  }, []);

  const handleReset = useCallback(() => {
    setReport(null);
    setErrorMessage(null);
  }, []);

  return (
    <section id="try" className="border-b border-ink-800">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <h2 className="text-3xl font-bold tracking-tight text-center">
          Try it now
        </h2>
        <p className="mt-3 text-center text-ink-400 max-w-2xl mx-auto">
          Paste your credentials and run triage live. Nothing is stored on the
          server — your keys leave your browser only for the duration of one
          request.
        </p>

        <div className="mt-12">
          <DemoForm onResult={handleResult} onError={handleError} />
        </div>

        {/* Results / error area */}
        <div ref={resultsRef} className="mt-12 scroll-mt-8">
          {errorMessage && !report ? (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              {errorMessage}
            </div>
          ) : null}
          {report ? (
            <TriageResults report={report} onReset={handleReset} />
          ) : null}
        </div>
      </div>
    </section>
  );
}
