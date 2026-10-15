import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

/**
 * D3: Problem (the longitudinal problem list) and Diagnosis (per encounter)
 * stay separate. "Add to problem list" turns an encounter diagnosis into a
 * problem — or links it to the patient's existing active problem for the same
 * condition — and records the link on Diagnosis.problemId. Both carry the same
 * code field (codeSystem + code + codeDisplay).
 */

export interface CodeInput { codeSystem?: string | null; code?: string | null; codeDisplay?: string | null }

/** Normalises a code field: blanks are absent; system and code come together; a display needs a code. */
export function normalizeCode(input: CodeInput): { codeSystem: string | null; code: string | null; codeDisplay: string | null } {
  const clean = (v?: string | null) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const codeSystem = clean(input.codeSystem);
  const code = clean(input.code);
  const codeDisplay = clean(input.codeDisplay);
  if ((codeSystem === null) !== (code === null)) throw new BadRequestError("codeSystem and code go together.");
  if (codeDisplay !== null && code === null) throw new BadRequestError("codeDisplay needs a code.");
  return { codeSystem, code, codeDisplay };
}

/**
 * Add an encounter diagnosis to the patient's problem list. Idempotent: a
 * diagnosis already on the list returns its problem. Matches an existing
 * active problem by code (when coded) or by text (when neither is coded);
 * otherwise creates one. One transaction.
 */
export async function addDiagnosisToProblemList(input: { facilityId: string; diagnosisId: string; byUserId: string }) {
  const result = await prisma.$transaction(async (tx) => {
    const dx = await tx.diagnosis.findUnique({ where: { id: input.diagnosisId }, include: { encounter: { select: { facilityId: true } } } });
    if (!dx || dx.encounter.facilityId !== input.facilityId) throw new NotFoundError("Diagnosis not found.");
    if (dx.status === "ENTERED_IN_ERROR") throw new BadRequestError("A diagnosis entered in error can't be added to the problem list.");
    if (dx.problemId) {
      return { problem: await tx.problem.findUniqueOrThrow({ where: { id: dx.problemId } }), created: false, linked: false };
    }

    const candidates = await tx.problem.findMany({ where: { patientId: dx.patientId, status: "ACTIVE" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
    const match = dx.code
      ? candidates.find((p) => p.codeSystem === dx.codeSystem && p.code === dx.code)
      : candidates.find((p) => !p.code && sameText(p.diagnosis, dx.diagnosis));

    const problem = match ?? await tx.problem.create({
      data: {
        patientId: dx.patientId,
        diagnosis: dx.diagnosis,
        // FHIR: a suspected problem is ACTIVE with verification PROVISIONAL.
        status: "ACTIVE",
        verificationStatus: dx.type === "PROVISIONAL" || dx.type === "RULE_OUT" ? "PROVISIONAL" : null,
        onsetDate: dx.onsetDate,
        codeSystem: dx.codeSystem,
        code: dx.code,
        codeDisplay: dx.codeDisplay,
      },
    });
    // Compare-and-set so two concurrent adds can't link twice.
    const cas = await tx.diagnosis.updateMany({ where: { id: dx.id, problemId: null }, data: { problemId: problem.id } });
    if (cas.count !== 1) throw new BadRequestError("This diagnosis was added to the problem list concurrently. Refresh and try again.");
    return { problem, created: !match, linked: true, patientId: dx.patientId, encounterId: dx.encounterId };
  });

  if (result.linked) {
    await recordAuditEvent(
      "hospital.problem.added",
      input.byUserId,
      { problemId: result.problem.id, fromDiagnosisId: input.diagnosisId, created: result.created },
      { facilityId: input.facilityId, patientId: result.problem.patientId, encounterId: "encounterId" in result ? result.encounterId : undefined }
    );
  }
  return { problem: result.problem, created: result.created };
}
