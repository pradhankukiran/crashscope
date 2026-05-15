/**
 * `cn` — the canonical shadcn/ui class merging helper.
 *
 * Combines `clsx` (conditional class expressions) with `tailwind-merge`
 * (conflict resolution for Tailwind utility classes). Used by every shadcn
 * component to merge their internal default classes with user-supplied
 * `className` props without producing duplicate or conflicting utilities.
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
