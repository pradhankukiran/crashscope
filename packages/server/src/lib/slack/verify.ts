/**
 * Slack request signing verification.
 *
 * Implements Slack's documented v0 signature scheme:
 *   https://api.slack.com/authentication/verifying-requests-from-slack
 *
 *   1. Concatenate `v0:<timestamp>:<raw body>`.
 *   2. Compute HMAC-SHA256 over that string using the signing secret.
 *   3. Prefix with `v0=` and compare (constant-time) against the
 *      `x-slack-signature` header.
 *   4. Reject any request whose timestamp is older than 5 minutes (replay
 *      protection).
 *
 * We accept the *raw* body string because Slack hashes the exact bytes it
 * sent. Re-serializing parsed form data would re-encode it and break the MAC.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

/** Slack's hard cutoff for replay protection. */
const MAX_AGE_SECONDS = 60 * 5;

/** Header names (lower-cased; Slack sends them lower-cased anyway). */
const SIGNATURE_HEADER = "x-slack-signature";
const TIMESTAMP_HEADER = "x-slack-request-timestamp";

/**
 * Constant-time compare two hex/ASCII strings.
 *
 * Returns false when buffers differ in length (which is itself information,
 * but `timingSafeEqual` requires equal-length buffers; a length mismatch
 * indicates malformed input, not a side channel we care about).
 */
function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify a Slack request.
 *
 * The caller is responsible for reading and passing the raw request body
 * exactly as received — Slack signs the bytes on the wire, not any parsed
 * representation.
 *
 * @param req Next request (we only read headers from it).
 * @param body The raw body string.
 * @param signingSecret Slack signing secret (from env).
 */
export function verifySlackRequest(
  req: NextRequest,
  body: string,
  signingSecret: string,
): boolean {
  if (!signingSecret) return false;

  const signature = req.headers.get(SIGNATURE_HEADER);
  const timestamp = req.headers.get(TIMESTAMP_HEADER);
  if (!signature || !timestamp) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > MAX_AGE_SECONDS) return false;

  const basestring = `v0:${timestamp}:${body}`;
  const computed =
    "v0=" + createHmac("sha256", signingSecret).update(basestring).digest("hex");

  return safeEqualHex(computed, signature);
}
