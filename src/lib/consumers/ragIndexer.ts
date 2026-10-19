import type { RagSourceType } from "@prisma/client";
import type { DomainEventConsumer } from "@/lib/events/consumers";
import { RetryableEventError } from "@/lib/events/types";
import { prisma } from "@/lib/db";
import { EmbeddingUnavailableError } from "@/lib/ai/embeddings";
import { indexSource, reindexPerson, removePersonAiIndex, setPersonOnFacilityIndex } from "@/lib/rag/indexer";
import { removeOwnerIndex } from "@/lib/rag/remove";
import { purgeProxyAiText } from "@/lib/rag/interactions";
import { vitalsDaySource, type SourceRef } from "@/lib/rag/sources";

/**
 * Week 4b — the rag-indexer (docs/RAG_DESIGN.md §5.1; reserved in the
 * workflow spine §2). Keeps the AI index in step with the record:
 *
 *   indexed     signed notes (amendments supersede), released lab and imaging
 *               results and their amendments, generated and recorded
 *               documents, vitals (one document per encounter-day),
 *               diagnoses, problems, allergies and the allergy status,
 *               referrals, discharge summaries, confirmed patient-provided
 *               records, person documents (title and date only)
 *   links       a link sets the Person on that record's documents; an unlink
 *               or supersede clears it (nothing is deleted)
 *   removals    AI consent declined: the Person's whole index; account
 *               closed or purged: their own documents; a family member's
 *               access revoked: the text kept of their AI questions about
 *               the patient; re-grant or reopening: re-indexed
 *   recorded    DocumentTranslated (unconfirmed text is never indexed),
 *               a consent lapsing at 18 (kept 90 days, then the runner's
 *               purge), merges (re-pointed in the merge's own transaction)
 * Idempotent: the same source version and content are nothing to do.
 */
type P = Record<string, unknown>;
const str = (p: P, k: string) => (typeof p[k] === "string" ? (p[k] as string) : null);

async function sourceOf(type: string, p: P): Promise<SourceRef | null> {
  const ref = (sourceType: RagSourceType, id: string | null) => (id ? { sourceType, sourceId: id } : null);
  switch (type) {
    case "ClinicalNoteSigned": return ref("CLINICAL_NOTE", str(p, "entryId"));
    case "LabResultReleased": return ref("LAB_RESULT", str(p, "resultId"));
    case "ImagingReportReleased": return ref("IMAGING_REPORT", str(p, "reportId"));
    case "DiagnosticReportAmended": return ref(p.reportKind === "LAB" ? "LAB_RESULT" : "IMAGING_REPORT", str(p, "amendedId"));
    case "DocumentGenerated": return p.isDraft ? null : ref("GENERATED_DOCUMENT", str(p, "documentId"));
    case "ClinicalDocumentRecorded": return ref("CLINICAL_DOCUMENT", str(p, "documentId"));
    case "DiagnosisRecorded": return ref("DIAGNOSIS", str(p, "diagnosisId"));
    case "ProblemListUpdated": return ref("PROBLEM", str(p, "problemId"));
    case "AllergyListUpdated": return p.source === "PATIENT_PROVIDED" ? null : ref("ALLERGY", str(p, "allergyId"));
    case "AllergyStatusRecorded": return ref("ALLERGY_STATUS", str(p, "patientId"));
    case "ReferralStatusChanged": return ref("REFERRAL", str(p, "referralId"));
    case "PatientDischarged": return ref("DISCHARGE_SUMMARY", str(p, "dischargeId"));
    case "PatientProvidedRecordAdded":
    case "PatientProvidedRecordUpdated": return ref("PATIENT_PROVIDED_RECORD", str(p, "recordId"));
    case "PersonDocumentUploaded":
    case "PersonDocumentWithdrawn": return ref("PATIENT_DOCUMENT", str(p, "documentId"));
    case "ObservationRecorded": {
      if (p.observationKind !== "VITALS" || !str(p, "observationId")) return null;
      const v = await prisma.vital.findUnique({ where: { id: str(p, "observationId")! }, select: { encounterId: true, recordedAt: true } });
      return v ? vitalsDaySource(v.encounterId, v.recordedAt) : null;
    }
    default: return null;
  }
}

export const RAG_INDEXER_EVENTS = [
  "ClinicalNoteSigned", "LabResultReleased", "ImagingReportReleased", "DiagnosticReportAmended", "DocumentGenerated", "ClinicalDocumentRecorded",
  "ObservationRecorded", "DiagnosisRecorded", "ProblemListUpdated", "AllergyListUpdated", "AllergyStatusRecorded", "ReferralStatusChanged", "PatientDischarged",
  "PatientProvidedRecordAdded", "PatientProvidedRecordUpdated", "DocumentTranslated", "PersonDocumentUploaded", "PersonDocumentWithdrawn",
  "PersonPatientLinked", "PersonPatientUnlinked", "PersonPatientLinkSuperseded", "PersonMerged",
  "PersonConsentDecided", "PersonConsentLapsed", "PersonAccountClosed", "PersonAccountReopened", "PersonDataPurged", "FamilyAccessRevoked", "ConsentRevoked",
] as const;

export const ragIndexer: DomainEventConsumer = {
  name: "rag-indexer",
  handles: RAG_INDEXER_EVENTS,
  async handle(event) {
    const p = event.payload as P;
    try {
      switch (event.eventType) {
        case "PersonPatientLinked":
          if (event.facilityId) await setPersonOnFacilityIndex(event.facilityId, String(p.patientId), String(p.personId));
          return;
        case "PersonPatientUnlinked":
        case "PersonPatientLinkSuperseded":
          if (event.facilityId) await setPersonOnFacilityIndex(event.facilityId, String(p.patientId), null);
          return;
        case "PersonConsentDecided":
          if (p.purpose !== "AI_ASSISTANCE") return;
          if (p.decision === "DECLINED") await removePersonAiIndex(String(p.personId));
          else await reindexPerson(String(p.personId));
          return;
        case "PersonAccountClosed":
        case "PersonDataPurged":
          await removeOwnerIndex(prisma, { personId: String(p.personId) });
          return;
        case "PersonAccountReopened":
          await reindexPerson(String(p.personId));
          return;
        case "FamilyAccessRevoked":
          await purgeProxyAiText(String(p.delegationId));
          return;
        case "DocumentTranslated":
        case "PersonConsentLapsed":
        case "PersonMerged":
        case "ConsentRevoked":
          return;
      }
      const ref = await sourceOf(event.eventType, p);
      if (ref) await indexSource(ref, { eventId: event.eventId });
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) throw new RetryableEventError(`Embedding provider unavailable: ${err.code}`, err.code);
      throw err;
    }
  },
};
