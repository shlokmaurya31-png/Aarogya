import { NextRequest, NextResponse } from "next/server";
import { handleGatewayWebhook } from "@/lib/insurance/hospitalPayments";

/**
 * Week 5c — a facility's own Razorpay webhook (payment.captured / payment.failed).
 * The raw body's signature is checked with THAT facility's webhook secret before
 * anything is read; an unverified call changes nothing (401). Verified calls
 * answer 200 with a closed outcome, so the gateway doesn't retry handled events.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ facilityId: string }> }) {
  const raw = await req.text();
  const outcome = await handleGatewayWebhook((await params).facilityId, raw, req.headers.get("x-razorpay-signature") ?? "", req.headers.get("x-razorpay-event-id") ?? undefined).catch(() => "ERROR" as const);
  if (outcome === "INVALID_SIGNATURE" || outcome === "NOT_CONFIGURED") return NextResponse.json({ ok: false }, { status: 401 });
  if (outcome === "ERROR") return NextResponse.json({ ok: false }, { status: 500 });
  return NextResponse.json({ ok: true, outcome });
}
