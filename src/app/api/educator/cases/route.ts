import { NextRequest } from "next/server";
import { Acuity, CaseSourceType, Difficulty } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requirePermission, withApiErrors } from "@/lib/auth/rbac";
import { DEFAULT_RUBRIC } from "@/lib/scoring/defaultRubrics";
import { assertSyntheticCaseIsClean } from "@/lib/privacy/caseSanitizer";
import { redactFreeText } from "@/lib/privacy/redaction";
import { recordAuditEvent } from "@/lib/auth/audit";

export async function GET() {
  return withApiErrors(async () => {
    await requirePermission("educator:case:review");
    const cases = await prisma.clinicalCase.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
    return {
      cases: cases.map((c) => ({
        id: c.id,
        slug: c.slug,
        title: c.title,
        specialty: c.specialty,
        difficulty: c.difficulty,
        acuity: c.acuity,
        sourceType: c.sourceType,
        isPublished: c.isPublished,
        authorId: c.authorId,
        createdAt: c.createdAt,
      })),
    };
  });
}

const CreateCaseSchema = z.object({
  title: z.string().min(4),
  specialty: z.string().min(2),
  difficulty: z.nativeEnum(Difficulty),
  acuity: z.nativeEnum(Acuity),
  chiefComplaint: z.string().min(4),
  presentation: z.string().min(10),
  patientAgeBand: z.string().min(2),
  patientSex: z.string().min(2),
  referenceDx: z.string().min(2),
  learningObjectives: z.array(z.string()).min(1),
});

/**
 * Minimal educator authoring endpoint — creates a structurally valid but
 * intentionally small case (no history tree / investigations yet). This
 * demonstrates the authoring architecture end-to-end without building the
 * full multi-step wizard from brief §38 in this pass — see
 * docs/STUDENT_PLATFORM_ARCHITECTURE.md §4.
 */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const session = await requirePermission("educator:case:create");
    const body = await req.json().catch(() => null);
    const parsed = CreateCaseSchema.safeParse(body);
    if (!parsed.success) {
      return { error: "Invalid case data.", issues: parsed.error.issues };
    }
    const input = parsed.data;

    // Educators author free text directly (unlike synthetic seed cases, which never touch real data
    // to begin with) — run every free-text field through the same redaction pass the Clinical Learning
    // Data Gateway uses, as a safety net against a real name/phone/ID being pasted in. See
    // docs/STUDENT_PLATFORM_THREAT_MODEL.md T-11.
    const sanitizedPresentation = redactFreeText(input.presentation).text;
    const sanitizedChiefComplaint = redactFreeText(input.chiefComplaint).text;
    const sanitizedTitle = redactFreeText(input.title).text;

    const content = {
      presentation: sanitizedPresentation,
      initialVitals: { hr: 80, sbp: 120, dbp: 80, rr: 16, spo2: 98, tempC: 37.0, gcs: 15, status: "stable" as const },
      historyTree: [],
      examFindings: [],
      investigations: [],
      redFlags: [],
      referenceDifferentials: [{ diagnosis: input.referenceDx, rationale: "Educator-authored reference diagnosis." }],
      managementPathway: [],
      criticalActions: [],
      unsafeActions: [],
      prescriptionContext: {
        allergies: [], pregnancyStatus: "not-applicable" as const, renalFunction: "normal" as const,
        hepaticFunction: "normal" as const, currentMedications: [], diagnoses: [input.referenceDx],
      },
      prescriptionReference: [],
      debrief: { pearls: [], references: [] },
    };

    assertSyntheticCaseIsClean(content);

    const slug = `EDU-CUSTOM-${Date.now().toString(36).toUpperCase()}`;
    const created = await prisma.clinicalCase.create({
      data: {
        slug,
        title: sanitizedTitle,
        specialty: input.specialty,
        difficulty: input.difficulty,
        acuity: input.acuity,
        sourceType: CaseSourceType.INSTITUTION_AUTHORED,
        learnerTracks: JSON.stringify(["MEDICINE"]),
        patientName: "Educator-authored educational patient",
        patientAgeBand: input.patientAgeBand,
        patientSex: input.patientSex,
        chiefComplaint: sanitizedChiefComplaint,
        learningObjectives: JSON.stringify(input.learningObjectives),
        content: content as object,
        referenceDx: input.referenceDx,
        rubric: DEFAULT_RUBRIC as object,
        viva: [] as object,
        authorId: session.userId,
        isPublished: false,
      },
    });

    await recordAuditEvent("educator.case.created", session.userId, { caseId: created.id, slug });
    return { case: { id: created.id, slug: created.slug } };
  });
}
