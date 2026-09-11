import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { buildAuthorizationActor } from "@/lib/auth/authorize/context";
import { authorizeAccess } from "@/lib/auth/authorize/engine";

/** Document metadata foundation (brief §26) — metadata-only this phase, see docs/CLINICAL_CORE.md §8. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);
    const patientId = searchParams.get("patientId");
    if (!patientId) throw new BadRequestError("patientId is required.");

    const patient = await prisma.patient.findUnique({ where: { id: patientId } });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");

    const includeSuperseded = searchParams.get("includeSuperseded") === "true";
    const documents = await prisma.clinicalDocument.findMany({
      where: { patientId, ...(includeSuperseded ? {} : { status: "CURRENT" }) },
      orderBy: { createdAt: "desc" },
    });

    // ── Phase C4: RESTRICTED document enforcement ────────────────────────
    //
    // C1 recorded accessPolicy but never enforced it on read, so a RESTRICTED
    // document was returned to any facility staff member holding patient:read.
    // That is the gap this closes.
    //
    // ONE authorization evaluation decides it for the whole list: the policy
    // turns on the ACTOR-to-PATIENT relationship, which is identical for every
    // row here, so evaluating per document would be N identical queries for one
    // answer.
    const restricted = documents.filter((d) => d.accessPolicy === "RESTRICTED");
    if (restricted.length === 0) return { documents, restrictedWithheld: 0 };

    const actor = await buildAuthorizationActor(searchParams.get("facilityId") ?? undefined);
    const decision = await authorizeAccess({
      actor,
      action: "document.read.restricted",
      resource: { type: "DOCUMENT", facilityId, patientId, dataClass: "HIGHLY_SENSITIVE" },
    });
    if (decision.decision === "ALLOW") return { documents, restrictedWithheld: 0 };

    // Withheld, not errored: the caller legitimately sees the unrestricted
    // documents. The count is returned so the UI can say "2 restricted
    // documents were withheld" rather than silently showing a shorter list —
    // silently hiding clinical data is its own safety problem.
    return {
      documents: documents.filter((d) => d.accessPolicy !== "RESTRICTED"),
      restrictedWithheld: restricted.length,
      restrictedDecision: decision.decision,
    };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("document:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Documents must be recorded by a staff account.");

    const { patientId, encounterId, type, title, accessPolicy, storageRef } = body ?? {};
    if (!patientId || !type || !title) throw new BadRequestError("patientId, type and title are required.");

    const patient = await prisma.patient.findUnique({ where: { id: patientId } });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");

    // IDOR fix (brief §21): a document may only be attached to an encounter
    // that belongs to the SAME patient and facility — never another
    // facility's or another patient's encounter.
    if (encounterId) {
      const encounter = await prisma.encounter.findUnique({ where: { id: encounterId } });
      if (!encounter || encounter.facilityId !== facilityId || encounter.patientId !== patientId) {
        throw new NotFoundError("Encounter not found.");
      }
    }

    const document = await prisma.clinicalDocument.create({
      data: {
        facilityId,
        patientId,
        encounterId,
        type,
        title,
        storageRef,
        accessPolicy: accessPolicy ?? "CLINICAL_STAFF",
        authorStaffId: staff.id,
        uploadedByStaffId: staff.id,
      },
    });

    await recordAuditEvent(
      "hospital.document.created",
      session.userId,
      { documentId: document.id, patientId, type },
      { facilityId, patientId, encounterId }
    );
    return { document };
  });
}
