"use client";

/**
 * CopyButton — small client island that copies a fixed string to the
 * clipboard via {@link navigator.clipboard.writeText}.
 *
 * Stays lean on purpose so it can be embedded inside server components
 * ({@link TerminalSnippet}, {@link Hero}, etc.) without dragging the host
 * across the client boundary. The icon flips to a Check tick for ~1.5s after
 * a successful copy, then reverts.
 *
 * Falls back silently if the clipboard API is unavailable (older browsers,
 * insecure contexts) — the button just won't enter the "copied" state.
 */

import { useCallback, useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface CopyButtonProps {
  /** Text written to the clipboard when the button is pressed. */
  value: string;
  /** Optional visible label (e.g. "Copy install command"). Icon-only when omitted. */
  label?: string;
  /** Accessible label used for the icon-only variant or to override the visible label. */
  ariaLabel?: string;
  /** Extra classes for the button. */
  className?: string;
  /** shadcn Button size token. Defaults to `sm`. */
  size?: "default" | "sm" | "lg" | "icon";
  /** shadcn Button variant token. Defaults to `outline`. */
  variant?:
    | "default"
    | "destructive"
    | "outline"
    | "secondary"
    | "ghost"
    | "link";
}

const COPIED_RESET_MS = 1500;

export function CopyButton({
  value,
  label,
  ariaLabel,
  className,
  size = "sm",
  variant = "outline",
}: CopyButtonProps): JSX.Element {
  const [copied, setCopied] = useState(false);

  // Auto-revert the "copied" indicator after a short delay.
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_RESET_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const handleClick = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    void navigator.clipboard.writeText(value).then(
      () => setCopied(true),
      () => {
        /* swallow — the button just won't flip to "copied". */
      },
    );
  }, [value]);

  const Icon = copied ? Check : Copy;
  const effectiveAriaLabel = ariaLabel ?? label ?? "Copy to clipboard";

  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      onClick={handleClick}
      aria-label={effectiveAriaLabel}
      className={cn(className)}
    >
      <Icon className={cn("h-3.5 w-3.5", copied && "text-emerald-600")} />
      {label ? <span>{copied ? "Copied" : label}</span> : null}
    </Button>
  );
}
