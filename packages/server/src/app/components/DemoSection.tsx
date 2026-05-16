"use client";

/**
 * DemoSection — the "Try it now" block that glues {@link DemoForm} and
 * {@link TriageResults} together on the landing page.
 *
 * Owns the transient state (last report, last error) so the surrounding page
 * can stay a server component. The triage run itself happens inside
 * `DemoForm`; this component just routes the callbacks and renders a card
 * shell with a separator between the form and the results.
 *
 * On a successful run we auto-scroll to the results area so visitors don't
 * have to hunt for it on long pages. The scroll is throttled to once per
 * report via the `report` dependency.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle } from "lucide-react";
import type { TriageReport } from "@pradhankukiran/crashscope-core";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

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
    <section id="try" className="border-b bg-muted/30">
      <div className="mx-auto max-w-6xl px-6 py-16">
        <Card className="shadow-sm">
          <CardHeader className="text-center">
            <CardTitle className="text-3xl font-bold tracking-tight">
              Preview before you install
            </CardTitle>
            <CardDescription className="mx-auto max-w-2xl text-base">
              Paste your credentials to see crashscope work against your data.
              When you&rsquo;re convinced, install the CLI.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-8 pt-2">
            <DemoForm onResult={handleResult} onError={handleError} />

            {(errorMessage && !report) || report ? (
              <>
                <Separator />
                <div ref={resultsRef} className="scroll-mt-8">
                  {errorMessage && !report ? (
                    <Alert variant="destructive">
                      <AlertCircle className="h-4 w-4" />
                      <AlertDescription>{errorMessage}</AlertDescription>
                    </Alert>
                  ) : null}
                  {report ? (
                    <TriageResults report={report} onReset={handleReset} />
                  ) : null}
                </div>
              </>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
