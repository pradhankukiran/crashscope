/**
 * POST /api/slack/command — Slack slash-command entrypoint for `/triage`.
 *
 * Slack imposes a 3-second response budget on slash commands; running the
 * triage pipeline inline would time out. The flow is therefore:
 *
 *   1. Verify the Slack signature against the *raw* body bytes.
 *   2. Parse the application/x-www-form-urlencoded payload.
 *   3. Respond immediately with a "Running triage…" placeholder (Slack
 *      replaces the user's command-typing with this message via
 *      `response_type: in_channel`).
 *   4. Fire off the triage pipeline in the background and POST the final
 *      Block Kit report to the `response_url` Slack provided, with
 *      `replace_original: true` so the placeholder is overwritten.
 *
 * On any failure (verification, parse, pipeline, or the final webhook POST)
 * we still try to deliver a user-visible error message via the response_url
 * — silent failures are the worst UX in chat.
 */
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { waitUntil } from "@vercel/functions";
import { CrashscopeError } from "@pradhankukiran/crashscope-core";
import { loadEnv } from "@/lib/env";
import { redactError } from "@/lib/redact";
import {
  buildErrorBlocks,
  buildTriageReportBlocks,
  type SlackBlock,
} from "@/lib/slack/blocks";
import { parseTriageCommand } from "@/lib/slack/parse";
import { verifySlackRequest } from "@/lib/slack/verify";
import { runTriage } from "@/lib/triage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/* ---------------------------------------------------------------------------
 * Slack-shaped payload typing
 * ------------------------------------------------------------------------- */

/**
 * Fields of the slash-command payload we actually use. Slack sends many more
 * (team_id, api_app_id, etc.); we narrow to keep the contract intentional.
 */
interface SlashCommandPayload {
  command: string;
  text: string;
  user_id: string;
  user_name?: string;
  channel_id: string;
  response_url: string;
}

/** Build a {@link SlashCommandPayload} from URL-encoded form data. */
function parseFormBody(body: string): Partial<SlashCommandPayload> {
  const params = new URLSearchParams(body);
  const out: Partial<SlashCommandPayload> = {};
  const command = params.get("command");
  const text = params.get("text");
  const userId = params.get("user_id");
  const userName = params.get("user_name");
  const channelId = params.get("channel_id");
  const responseUrl = params.get("response_url");
  if (command !== null) out.command = command;
  if (text !== null) out.text = text;
  if (userId !== null) out.user_id = userId;
  if (userName !== null) out.user_name = userName;
  if (channelId !== null) out.channel_id = channelId;
  if (responseUrl !== null) out.response_url = responseUrl;
  return out;
}

/** Strict guard that the parsed form payload has the fields we require. */
function isCompletePayload(
  p: Partial<SlashCommandPayload>,
): p is SlashCommandPayload {
  return Boolean(p.command && p.user_id && p.channel_id && p.response_url);
}

/* ---------------------------------------------------------------------------
 * response_url callback helpers
 * ------------------------------------------------------------------------- */

/**
 * POST a Block Kit message to Slack's `response_url` to replace the
 * placeholder. Errors are logged but swallowed — the user already saw the
 * placeholder and we can't usefully bubble a failure back to them after
 * returning 200 above.
 */
async function postToResponseUrl(
  responseUrl: string,
  blocks: SlackBlock[],
  fallbackText: string,
  requestId: string,
): Promise<void> {
  try {
    const res = await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        response_type: "in_channel",
        replace_original: true,
        text: fallbackText,
        blocks,
      }),
    });
    if (!res.ok) {
      console.error(
        `[slack] response_url POST failed requestId=${requestId} status=${res.status}`,
      );
    }
  } catch (err: unknown) {
    console.error(
      `[slack] response_url POST threw requestId=${requestId}`,
      redactError(err),
    );
  }
}

/**
 * Run the triage pipeline and push the result to the response_url. Wrapped
 * in its own function so it can be fire-and-forgot from the request handler
 * without the surrounding `Promise.resolve().then(...)` plumbing leaking.
 */
async function runAndPostback(
  payload: SlashCommandPayload,
  requestId: string,
): Promise<void> {
  const opts = parseTriageCommand(payload.text);
  try {
    const report = await runTriage(opts);
    const blocks = buildTriageReportBlocks(report);
    await postToResponseUrl(
      payload.response_url,
      blocks,
      `Triage report — ${report.window} (${report.summary.total} issues)`,
      requestId,
    );
  } catch (err: unknown) {
    const message =
      err instanceof CrashscopeError
        ? err.message
        : "Triage failed unexpectedly. Check server logs.";
    console.error(
      `[slack] runAndPostback failed requestId=${requestId}`,
      redactError(err),
    );
    await postToResponseUrl(
      payload.response_url,
      buildErrorBlocks({ message, requestId }),
      "Triage failed",
      requestId,
    );
  }
}

/* ---------------------------------------------------------------------------
 * Route handler
 * ------------------------------------------------------------------------- */

/**
 * Build a Slack-shaped error response for 4xx situations *before* we've
 * acknowledged the slash command. Sent with `response_type: "ephemeral"` so
 * only the invoking user sees the error.
 */
function ephemeralError(message: string): NextResponse {
  return NextResponse.json(
    {
      response_type: "ephemeral",
      text: `:x: ${message}`,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  let env;
  try {
    env = loadEnv();
  } catch {
    // We deliberately don't expose the missing-vars list to Slack — the
    // operator will see it in server logs via the underlying ConfigError.
    return ephemeralError("Crashscope server is misconfigured.");
  }
  if (!env.SLACK_SIGNING_SECRET) {
    return ephemeralError("Crashscope server is missing SLACK_SIGNING_SECRET.");
  }

  // Read the raw body once — Slack signs the bytes we received, not the
  // parsed payload, so re-serializing would break verification.
  const rawBody = await req.text();
  if (!verifySlackRequest(req, rawBody, env.SLACK_SIGNING_SECRET)) {
    console.warn(`[slack] signature_invalid requestId=${requestId}`);
    return ephemeralError("Invalid Slack signature.");
  }

  const parsed = parseFormBody(rawBody);
  if (!isCompletePayload(parsed)) {
    return ephemeralError("Malformed slash command payload.");
  }

  console.info(
    `[slack] /triage start requestId=${requestId} user=${parsed.user_id} channel=${parsed.channel_id}`,
  );

  // Fire-and-forget background work. `waitUntil` is the canonical Next 14 /
  // Vercel pattern: on serverless, the runtime would otherwise tear the
  // function down as soon as we `return` below, killing the triage
  // mid-flight; calling it tells Vercel to keep the function alive until the
  // promise settles.
  //
  // Outside Vercel — Railway, any Docker host, `next dev`, etc. — `waitUntil`
  // from `@vercel/functions` is a safe no-op, and the long-running Node
  // process keeps the promise running on its own because we hold a reference
  // via the closure. The same code path therefore works on both platforms;
  // the postback eventually fires either way.
  waitUntil(runAndPostback(parsed, requestId));

  return NextResponse.json(
    {
      response_type: "in_channel",
      text: ":mag: Running triage… results will replace this message shortly.",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
