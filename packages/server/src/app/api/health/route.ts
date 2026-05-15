/**
 * GET /api/health
 *
 * Lightweight liveness probe for uptime checks and the Vercel deploy preview.
 * Returns the package version and seconds-since-boot for the current Node
 * process. Intentionally requires no auth so monitoring tools can hit it
 * without rotating credentials.
 */
import { NextResponse } from "next/server";

/**
 * The Node process records its start time at module load; subsequent boots
 * in a new isolate will see a fresh `bootTimeMs`. Good enough for "is this
 * function awake" without pulling in `process.uptime()` semantics.
 */
const bootTimeMs = Date.now();

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  return NextResponse.json(
    {
      status: "ok",
      version: process.env["npm_package_version"] ?? "0.1.0",
      uptime: Math.round((Date.now() - bootTimeMs) / 1000),
    },
    {
      headers: { "Cache-Control": "no-store" },
    },
  );
}
