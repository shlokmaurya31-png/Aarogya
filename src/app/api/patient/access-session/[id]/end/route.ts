import { NextRequest } from "next/server";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { requirePatientSelf } from "@/lib/auth/patientRbac";
import { prisma } from "@/lib/db";
import { endAccessSession } from "@/lib/patient/accessSession";

/** POST — the patient revokes/ends their own access session. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { session: authSession, patient } = await requirePatientSelf();
    const { id } = await params;

    const existing = await prisma.patientAccessSession.findUnique({ where: { id } });
    if (!existing || existing.patientId !== patient.id) throw new NotFoundError("Session not found.");

    // If still PENDING (never redeemed), cancel it; if ACTIVE, end it.
    if (existing.status === "PENDING") {
      await prisma.patientAccessSession.updateMany({
        where: { id, status: "PENDING" },
        data: { status: "CANCELLED", endedAt: new Date(), endedBy: "PATIENT" },
      });
      return { ok: true, status: "CANCELLED" };
    }

    const ended = await endAccessSession(id, "PATIENT", authSession.userId);
    return { ok: true, status: ended?.status ?? "ENDED" };
  });
}
