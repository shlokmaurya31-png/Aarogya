import { NextRequest } from "next/server";
import { z } from "zod";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { requirePatientActor, resolveActScope } from "@/lib/patient/context";
import { initiatePatientPayment } from "@/lib/patient/experience/payments";

/**
 * Initiate a payment for one of the patient's OWN invoices. The body carries
 * ONLY an invoiceId — the amount is computed server-side from the canonical
 * invoice and a client-supplied amount is never read (brief §50). No provider is
 * configured, so this returns PROVIDER_NOT_CONFIGURED rather than any fake success.
 */
const PaySchema = z.object({ invoiceId: z.string().min(1) }).strict();

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const ctx = await requirePatientActor();
    const scope = await resolveActScope(ctx);
    const parsed = PaySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError("An invoice is required.");
    const result = await initiatePatientPayment(scope, { invoiceId: parsed.data.invoiceId });
    await recordAuditEvent("patient.payment.initiated", ctx.userId,
      { invoiceId: result.invoiceId, amountMinor: result.amountMinor, status: result.status },
      { patientId: scope.patientId, facilityId: scope.facilityId });
    return result;
  });
}
