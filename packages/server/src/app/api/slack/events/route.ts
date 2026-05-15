/**
 * POST /api/slack/events — Slack Events API endpoint.
 *
 * v1 of crashscope doesn't subscribe to any events, but Slack requires the
 * URL to exist (and to pass the one-time `url_verification` challenge) before
 * you can save the app config. We answer challenges and otherwise no-op.
 *
 * Signature verification still applies to all callbacks; a missing signing
 * secret is a server misconfiguration we surface as 500 rather than
 * accepting unverified payloads.
 */
import { NextResponse, type NextRequest } from "next/server";
import { loadEnv } from "@/lib/env";
import { verifySlackRequest } from "@/lib/slack/verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Subset of the Slack Events API envelope we read. Both `type` and `challenge`
 * are optional because Slack also sends event_callback envelopes (which we
 * acknowledge with an empty 200).
 */
interface SlackEventEnvelope {
  type?: string;
  challenge?: string;
}

/** Defensive parse — bad JSON shouldn't throw out of the handler. */
function safeJsonParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let env;
  try {
    env = loadEnv();
  } catch {
    return NextResponse.json(
      { error: "CONFIG_ERROR", message: "Server is misconfigured." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!env.SLACK_SIGNING_SECRET) {
    return NextResponse.json(
      {
        error: "CONFIG_ERROR",
        message: "Server is missing SLACK_SIGNING_SECRET.",
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }

  const rawBody = await req.text();
  if (!verifySlackRequest(req, rawBody, env.SLACK_SIGNING_SECRET)) {
    return NextResponse.json(
      { error: "UNAUTHORIZED", message: "Invalid Slack signature." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const payload = safeJsonParse(rawBody) as SlackEventEnvelope | null;
  if (!payload || typeof payload !== "object") {
    return NextResponse.json(
      { error: "BAD_REQUEST", message: "Malformed event payload." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  // URL verification handshake — Slack sends this once when the events URL
  // is configured; we echo back the challenge to prove ownership.
  if (payload.type === "url_verification" && typeof payload.challenge === "string") {
    return NextResponse.json(
      { challenge: payload.challenge },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // We don't subscribe to events in v1; ack so Slack doesn't retry.
  return NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}
