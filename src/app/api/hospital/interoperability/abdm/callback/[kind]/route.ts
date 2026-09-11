import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAbdmConfig } from "@/lib/hospital/interoperability/abdm/config";
import { receiveCallback, CALLBACK_TOKEN_HEADER, MAX_CALLBACK_BYTES } from "@/lib/hospital/interoperability/abdm/callbacks";
import { ABDM_CALLBACK_PATHS, ABDM_HEADERS, type AbdmCallbackKind } from "@/lib/hospital/interoperability/abdm/contract";
import { InteropError } from "@/lib/hospital/interoperability/abdm/errors";

/**
 * Phase C2 — inbound ABDM callback endpoint.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * This route is PUBLIC by necessity: the ABDM Consent Manager calls it, and it
 * has no Aarogya session. That makes it the most exposed surface in the system,
 * so it deliberately does the least possible work before authenticating.
 *
 * It does NOT use requireFacilityStaff — there is no user here. Instead:
 *   - a deployment-configured shared secret authenticates the caller
 *   - the facility is resolved from the correlated exchange, NEVER from the body
 *   - the patient is likewise derived, never accepted
 *   - a replayed callback collides on a unique ledger row
 *
 * It never mutates clinical state. It records that a callback arrived and
 * correlates it; acting on the content is a separate, authorized operation.
 * ════════════════════════════════════════════════════════════════════════════
 */

const VALID_KINDS = new Set(Object.keys(ABDM_CALLBACK_PATHS));

export async function POST(req: NextRequest, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;

  // Unknown callback kind: refuse without revealing which kinds exist.
  if (!VALID_KINDS.has(kind)) {
    return NextResponse.json({ error: "Unknown callback." }, { status: 404 });
  }

  const config = getAbdmConfig();

  // Size ceiling on the declared length, before the body is read.
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared && declared > MAX_CALLBACK_BYTES) {
    return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  }

  try {
    const rawBody = await req.text();

    // The facility is NOT taken from the payload. A callback can only ever be
    // matched against exchanges that already exist, so we correlate across the
    // facilities that have an open exchange and let receiveCallback prove the
    // match. Without a match the callback is recorded UNMATCHED and ignored.
    const candidate = await resolveFacilityForCallback(rawBody, req.headers.get(ABDM_HEADERS.requestId));

    if (!candidate) {
      // Authenticate anyway so an unauthenticated prober cannot distinguish
      // "no matching exchange" from "wrong token" by timing or status.
      const { authenticateCallback, validateCallbackTimestamp } = await import(
        "@/lib/hospital/interoperability/abdm/callbacks"
      );
      authenticateCallback(config, req.headers.get(CALLBACK_TOKEN_HEADER));
      validateCallbackTimestamp(req.headers.get(ABDM_HEADERS.timestamp));
      return NextResponse.json({ status: "UNMATCHED" }, { status: 202 });
    }

    const result = await receiveCallback({
      config,
      facilityId: candidate,
      envelope: {
        kind: kind as AbdmCallbackKind,
        rawBody,
        headers: {
          token: req.headers.get(CALLBACK_TOKEN_HEADER),
          requestId: req.headers.get(ABDM_HEADERS.requestId),
          timestamp: req.headers.get(ABDM_HEADERS.timestamp),
          hiuId: req.headers.get(ABDM_HEADERS.hiuId),
        },
        sourceAddress: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      },
    });

    // 202 for every non-security outcome: the gateway must not be encouraged to
    // retry a callback we have deliberately ignored or already processed.
    return NextResponse.json({ status: result.status }, { status: 202 });
  } catch (error) {
    if (error instanceof InteropError && error.kind === "CALLBACK_ERROR") {
      // A fixed body: nothing about why authentication failed is disclosed.
      return NextResponse.json({ error: "Callback rejected." }, { status: 401 });
    }
    // Log the message ONLY. The raw error can close over the request body, and
    // a callback body carries clinical content, so it must never reach a log.
    console.error(
      "ABDM callback processing failed",
      error instanceof Error ? error.message : "non-Error thrown"
    );
    return NextResponse.json({ error: "Callback could not be processed." }, { status: 500 });
  }
}

/**
 * Find which facility an inbound callback belongs to by locating the exchange
 * that originated it. Returns null when nothing matches, which is treated as
 * UNMATCHED rather than as an error.
 */
async function resolveFacilityForCallback(rawBody: string, headerRequestId: string | null): Promise<string | null> {
  let externalRequestId: string | null = null;
  try {
    const parsed = JSON.parse(rawBody) as { response?: { requestId?: unknown } };
    const rid = parsed?.response?.requestId;
    if (typeof rid === "string" && rid.length <= 128) externalRequestId = rid;
  } catch {
    // Malformed JSON is handled inside receiveCallback, after authentication.
  }
  if (!externalRequestId && headerRequestId && headerRequestId.length <= 128) {
    externalRequestId = headerRequestId;
  }
  if (!externalRequestId) return null;

  const exchange = await prisma.healthInformationExchange.findFirst({
    where: { OR: [{ correlationId: externalRequestId }, { externalRequestId }] },
    select: { facilityId: true },
  });
  return exchange?.facilityId ?? null;
}

/** Callbacks are POST-only. */
export async function GET() {
  return NextResponse.json({ error: "Method not allowed." }, { status: 405 });
}
