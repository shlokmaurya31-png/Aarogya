import type { RagSourceType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { realDataEnabled } from "@/lib/ai/realData";
import { indexSource } from "./indexer";
import { vitalsDaySource, type SourceRef } from "./sources";

/**
 * Week 4b — npm run rag:backfill -- --facility <id> [--since <date>]
 * (docs/RAG_DESIGN.md §5.7). Uses the indexer's own function, so the result
 * matches having consumed every event; a resumable cursor per (facility,
 * source type); rate-limited by the batch size and a pause between batches;
 * refuses a facility the real-data switch doesn't allow; emits no events.
 * Person-owned sources are indexed through their own events, a consent
 * re-grant or an account reopening (reindexPerson).
 */
const TYPES: RagSourceType[] = ["CLINICAL_NOTE", "LAB_RESULT", "IMAGING_REPORT", "DIAGNOSIS", "PROBLEM", "ALLERGY", "ALLERGY_STATUS", "OBSERVATION", "REFERRAL", "DISCHARGE_SUMMARY", "CLINICAL_DOCUMENT"];

async function page(facilityId: string, type: RagSourceType, after: string, since: Date | undefined, take: number): Promise<SourceRef[]> {
  const gt = { gt: after };
  const at = since ? { gte: since } : undefined;
  const ids = (rows: { id: string }[], t: RagSourceType = type) => rows.map((r) => ({ sourceType: t, sourceId: r.id }));
  switch (type) {
    case "CLINICAL_NOTE": return ids(await prisma.clinicalNote.findMany({ where: { id: gt, encounter: { facilityId }, status: { in: ["SIGNED", "AMENDED"] }, ...(at ? { createdAt: at } : {}) }, orderBy: { id: "asc" }, take, select: { id: true } }));
    case "LAB_RESULT": return ids(await prisma.labResult.findMany({ where: { id: gt, labOrder: { patient: { facilityId } }, isCurrent: true, status: { in: ["VERIFIED", "AMENDED"] }, ...(at ? { resultedAt: at } : {}) }, orderBy: { id: "asc" }, take, select: { id: true } }));
    case "IMAGING_REPORT": return ids(await prisma.imagingReport.findMany({ where: { id: gt, imagingOrder: { patient: { facilityId } }, isCurrent: true, status: { in: ["VERIFIED", "AMENDED"] }, ...(at ? { reportedAt: at } : {}) }, orderBy: { id: "asc" }, take, select: { id: true } }));
    case "DIAGNOSIS": return ids(await prisma.diagnosis.findMany({ where: { id: gt, encounter: { facilityId }, status: { not: "ENTERED_IN_ERROR" }, ...(at ? { createdAt: at } : {}) }, orderBy: { id: "asc" }, take, select: { id: true } }));
    case "PROBLEM": return ids(await prisma.problem.findMany({ where: { id: gt, patient: { facilityId }, ...(at ? { createdAt: at } : {}) }, orderBy: { id: "asc" }, take, select: { id: true } }));
    case "ALLERGY": return ids(await prisma.allergy.findMany({ where: { id: gt, patient: { facilityId }, source: "CLINICIAN", status: { not: "ENTERED_IN_ERROR" }, ...(at ? { recordedAt: at } : {}) }, orderBy: { id: "asc" }, take, select: { id: true } }));
    case "ALLERGY_STATUS": return (await prisma.allergyStatusEntry.findMany({ where: { patientId: gt, facilityId, ...(at ? { recordedAt: at } : {}) }, orderBy: { patientId: "asc" }, distinct: ["patientId"], take, select: { patientId: true } })).map((r) => ({ sourceType: type, sourceId: r.patientId }));
    case "OBSERVATION": {
      // Vitals are grouped per encounter-day: the cursor walks vital rows.
      const rows = await prisma.vital.findMany({ where: { id: gt, encounter: { facilityId }, ...(at ? { recordedAt: at } : {}) }, orderBy: { id: "asc" }, take, select: { id: true, encounterId: true, recordedAt: true } });
      return rows.map((r) => ({ ...vitalsDaySource(r.encounterId, r.recordedAt), cursor: r.id }));
    }
    case "REFERRAL": return ids(await prisma.referral.findMany({ where: { id: gt, patient: { facilityId }, status: { not: "DRAFT" }, ...(at ? { createdAt: at } : {}) }, orderBy: { id: "asc" }, take, select: { id: true } }));
    case "DISCHARGE_SUMMARY": return ids(await prisma.discharge.findMany({ where: { id: gt, admission: { encounter: { facilityId } }, dischargedAt: { not: null, ...(since ? { gte: since } : {}) } }, orderBy: { id: "asc" }, take, select: { id: true } }));
    case "CLINICAL_DOCUMENT": return (await prisma.clinicalDocument.findMany({ where: { id: gt, facilityId, uploadedByUserId: null, status: "CURRENT", ...(at ? { createdAt: at } : {}) }, orderBy: { id: "asc" }, take, select: { id: true, generatedDocumentId: true } })).map((r) => ({ sourceType: r.generatedDocumentId ? "GENERATED_DOCUMENT" : "CLINICAL_DOCUMENT", sourceId: r.id }));
    default: return [];
  }
}

export async function backfillFacility(input: { facilityId: string; since?: Date; batchSize?: number; pauseMs?: number; restart?: boolean }): Promise<{ indexed: number; seen: number; byType: Record<string, number> }> {
  const facility = await prisma.facility.findUnique({ where: { id: input.facilityId }, select: { dataClassification: true } });
  if (!facility) throw new NotFoundError("Facility not found.");
  if (facility.dataClassification !== "SYNTHETIC" && !realDataEnabled()) throw new BadRequestError("This facility holds real data and the real-data switch is off: refused.");
  if (input.restart) await prisma.ragBackfillCursor.deleteMany({ where: { facilityId: input.facilityId } });
  const take = input.batchSize ?? 100;
  let indexed = 0, seen = 0;
  const byType: Record<string, number> = {};
  for (const type of TYPES) {
    for (;;) {
      const cur = await prisma.ragBackfillCursor.findUnique({ where: { facilityId_sourceType: { facilityId: input.facilityId, sourceType: type } } });
      const refs = await page(input.facilityId, type, cur?.lastSourceId ?? "", input.since, take);
      if (!refs.length) break;
      for (const ref of refs) {
        seen += 1;
        if ((await indexSource({ sourceType: ref.sourceType, sourceId: ref.sourceId })).outcome === "INDEXED") { indexed += 1; byType[type] = (byType[type] ?? 0) + 1; }
      }
      const last = refs.at(-1) as SourceRef & { cursor?: string };
      const lastSourceId = last.cursor ?? last.sourceId;
      await prisma.ragBackfillCursor.upsert({ where: { facilityId_sourceType: { facilityId: input.facilityId, sourceType: type } }, create: { facilityId: input.facilityId, sourceType: type, lastSourceId }, update: { lastSourceId } });
      if (refs.length < take) break;
      if (input.pauseMs) await new Promise((r) => setTimeout(r, input.pauseMs));
    }
  }
  return { indexed, seen, byType };
}
