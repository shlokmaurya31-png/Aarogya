import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requirePatientSelf } from "@/lib/auth/patientRbac";
import { prisma } from "@/lib/db";
import { issueAccessCode, prettyCode, enforceActiveExpiry } from "@/lib/patient/accessSession";

/** GET — the patient's current live (PENDING/ACTIVE) access session, if any. */
export async function GET() {
  return withApiErrors(async () => {
    const { patient } = await requirePatientSelf();
    const found = await prisma.patientAccessSession.findFirst({
      where: { patientId: patient.id, status: { in: ["PENDING", "ACTIVE"] } },
      orderBy: { createdAt: "desc" },
    });
    if (!found) return { session: null };
    // Reflect an auto-log-off if the consult window lapsed.
    const session = await enforceActiveExpiry(found);
    if (session.status !== "PENDING" && session.status !== "ACTIVE") return { session: null };
    // Never return the code/hash — the plaintext is only shown once at issue time.
    return {
      session: {
        id: session.id,
        status: session.status,
        purpose: session.purpose,
        expiresAt: session.expiresAt,
        redeemedAt: session.redeemedAt,
        doctorName: session.doctorName,
      },
    };
  });
}

/** POST — issue a fresh code for the patient to hand to a doctor. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const { session: authSession, patient } = await requirePatientSelf();
    const body = await req.json().catch(() => ({}));
    const purpose = typeof body?.purpose === "string" ? body.purpose : undefined;

    const { session, code } = await issueAccessCode(patient.id, authSession.userId, purpose);

    return {
      session: { id: session.id, status: session.status, expiresAt: session.expiresAt },
      // Shown once. The patient reads this to the doctor.
      code,
      displayCode: prettyCode(code),
    };
  });
}
