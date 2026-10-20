import { NextRequest } from "next/server";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { DEFAULT_SHARE_CATEGORIES, parseShareChoice } from "@/lib/sharing/categories";
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
        shareId: session.shareId,
        expiresAt: session.expiresAt,
        redeemedAt: session.redeemedAt,
        doctorName: session.doctorName,
      },
    };
  });
}

/**
 * POST — issue a fresh code for the patient to hand to a doctor. Week 4c: body
 * { categories?, sensitiveCategories?, period?: { from?, to? }, purpose?, validHours? } —
 * what the code shares (default since the 4c fix: every non-sensitive category,
 * uploads included, except clinical notes; nothing sensitive; 24 hours).
 */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const { session: authSession, patient } = await requirePatientSelf();
    const body = await req.json().catch(() => ({}));
    const note = typeof body?.note === "string" ? body.note : undefined;
    const choice = parseShareChoice(body, { categories: DEFAULT_SHARE_CATEGORIES });
    const validHours = body?.validHours === undefined ? undefined : Number(body.validHours);
    if (validHours !== undefined && (!Number.isInteger(validHours) || validHours < 1 || validHours > 24)) throw new BadRequestError("validHours must be 1–24.");

    const { session, code } = await issueAccessCode(patient.id, authSession.userId, note, { choice, validHours });

    return {
      session: { id: session.id, status: session.status, expiresAt: session.expiresAt },
      // Shown once. The patient reads this to the doctor.
      code,
      displayCode: prettyCode(code),
    };
  });
}
