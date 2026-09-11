import { NextRequest, NextResponse } from "next/server";
import {
  receiveCallback, getCallbackConfig,
  NHCX_CALLBACK_TOKEN_HEADER, MAX_CALLBACK_BYTES,
} from "@/lib/hospital/nhcx/callbacks";
import { NhcxError } from "@/lib/hospital/nhcx/errors";

/**
 * Phase C5 — inbound NHCX callback endpoint.
 *
 * This is the one unauthenticated-by-session surface in the claims boundary, so
 * it is treated as hostile input end to end:
 *
 *   - the shared secret is compared in constant time and MUST be configured;
 *     an unconfigured deployment rejects every callback rather than accepting
 *     anything
 *   - the facility is resolved from the exchange WE created, never from the body
 *   - correlation ids are matched against server-generated UUIDs
 *   - replay is stopped by a unique constraint, not by a lookup
 *   - the body is size-capped before it is parsed
 *
 * A callback that we deliberately ignore (duplicate, unmatched, conflicting)
 * answers 202: it was received and decided upon. Returning 4xx/5xx there would
 * invite the network to retry something we have already rejected on purpose.
 * Security failures answer 401/400 and record nothing.
 */
export async function POST(req: NextRequest) {
  const config = getCallbackConfig();

  // Read the body as raw text: the hash must cover exactly the bytes received,
  // not a re-serialisation of a parsed object.
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_CALLBACK_BYTES) {
    return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  }

  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json({ error: "Unreadable body." }, { status: 400 });
  }

  try {
    const result = await receiveCallback({
      config,
      envelope: {
        headers: {
          token: req.headers.get(NHCX_CALLBACK_TOKEN_HEADER),
          timestamp: req.headers.get("x-nhcx-timestamp"),
          correlationId: req.headers.get("x-nhcx-correlation-id"),
        },
        messageType: (req.headers.get("x-nhcx-message-type") ?? "UNKNOWN").slice(0, 64),
        rawBody,
        // Best-effort only, and used for investigation rather than for any
        // access decision — a proxy header is not an identity.
        sourceAddress: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      },
    });

    return NextResponse.json(
      { status: result.status, reason: result.reason ?? null },
      { status: 202 }
    );
  } catch (err) {
    if (err instanceof NhcxError) {
      const status = err.category === "AUTHENTICATION" || err.category === "AUTHORIZATION" ? 401 : 400;
      // The message is intentionally generic: a caller that failed authentication
      // learns nothing about which exchanges exist.
      return NextResponse.json({ error: status === 401 ? "Unauthorized." : "Invalid callback." }, { status });
    }
    return NextResponse.json({ error: "Callback could not be processed." }, { status: 500 });
  }
}
