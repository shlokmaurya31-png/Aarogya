import { NextRequest, NextResponse } from "next/server";
import type { BillingProviderKind } from "@prisma/client";
import { ingestWebhook } from "@/lib/billing/webhooks";

/**
 * Provider webhook receiver. Deliberately UNAUTHENTICATED at the session layer:
 * authenticity comes from the provider signature, verified inside ingestWebhook —
 * never from a logged-in user. The raw body is read verbatim (signatures are over
 * the exact bytes). A bad signature returns 400 (rejected, not applied); a valid
 * or duplicate event returns 200 so the provider does not needlessly retry.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  const kind = provider.toUpperCase();
  if (kind !== "FAKE" && kind !== "NONE") {
    return NextResponse.json({ error: "Unknown or unconfigured provider." }, { status: 404 });
  }
  const payload = await req.text();
  const signature = req.headers.get("x-aarogya-signature") ?? "";
  try {
    const result = await ingestWebhook({ providerKind: kind as BillingProviderKind, payload, signature });
    const status = result.status === "REJECTED" ? 400 : 200;
    return NextResponse.json(result, { status });
  } catch {
    // Do not leak internals to an unauthenticated caller.
    return NextResponse.json({ status: "ERROR" }, { status: 400 });
  }
}
