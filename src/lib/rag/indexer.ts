import { createHash } from "node:crypto";
import type { Prisma, RagWithdrawReason } from "@prisma/client";
import { prisma } from "@/lib/db";
import { aiAssistancePermit, type AiDataOwner, type AiRefusal } from "@/lib/ai/realData";
import { renderSource } from "./render";
import { chunkSections } from "./chunk";
import { chunkEmbeddingText, computeEmbeddings, writableSpaces, writeEmbeddings } from "./embed";
import { removeOwnerIndex } from "./remove";
import { loadSource, vitalsDaySource, type SourceRef } from "./sources";

type Tx = Prisma.TransactionClient;

/**
 * Week 4b — the rag-indexer's work (docs/RAG_DESIGN.md §5): one source in,
 * its index brought up to date.
 *   - Idempotent: the same source version with the same content hash is
 *     nothing to do (no provider call) — redelivery and replay create nothing.
 *   - A change (amendment, correction, a diagnosis resolved, an allergy
 *     inactivated) is a new version: the new document and chunks are written
 *     and the old one SUPERSEDED with its chunks deleted, in one transaction;
 *     an amendment names its predecessor (supersedes), which goes the same way.
 *   - Embeddings are computed before the write transaction, for the active
 *     space and any being built; the write re-checks the latest version and
 *     drops a stale write.
 *   - The AI gate is asked first: a refused owner (switch off for real data,
 *     AI consent declined or lapsed) is skipped and its index for that source
 *     removed; nothing is ever indexed for it.
 *   - Unconfirmed extracted facts are never a source (only confirmed
 *     PatientProvidedRecords are).
 */
export type IndexOutcome = { outcome: "INDEXED" | "UNCHANGED" | "WITHDRAWN" | "NOT_YET" | "NEVER" | "STALE" } | { outcome: "SKIPPED"; reason: AiRefusal };

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ownerOf = (o: { kind: "FACILITY"; facilityId: string; patientId: string } | { kind: "PERSON"; personId: string }): AiDataOwner => (o.kind === "PERSON" ? { personId: o.personId } : { facilityId: o.facilityId, patientId: o.patientId });

/** Retires a source's ACTIVE documents (chunks and embeddings deleted; the row stays as a tombstone). */
async function retire(tx: Tx, ref: SourceRef, reason: RagWithdrawReason, exceptId?: string): Promise<number> {
  const docs = await tx.ragDocument.findMany({ where: { sourceType: ref.sourceType, sourceId: ref.sourceId, status: "ACTIVE", ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
  if (!docs.length) return 0;
  const ids = docs.map((d) => d.id);
  await tx.ragChunk.deleteMany({ where: { documentId: { in: ids } } });
  await tx.ragDocument.updateMany({ where: { id: { in: ids } }, data: reason === "AMENDED" ? { status: "SUPERSEDED" } : { status: "WITHDRAWN", withdrawnAt: new Date(), withdrawnReason: reason } });
  return ids.length;
}

export async function withdrawSource(ref: SourceRef, reason: RagWithdrawReason): Promise<number> {
  return prisma.$transaction((tx) => retire(tx, ref, reason));
}

export async function indexSource(ref: SourceRef, opts: { eventId?: string } = {}): Promise<IndexOutcome> {
  const loaded = await loadSource(ref);
  if (loaded.action === "WITHDRAW") {
    await withdrawSource(ref, loaded.reason);
    return { outcome: "WITHDRAWN" };
  }
  if (loaded.action !== "INDEX") return { outcome: loaded.action };
  const gate = await aiAssistancePermit(ownerOf(loaded.owner));
  if (!gate.allowed) {
    await withdrawSource(ref, "CONSENT_WITHDRAWN");
    return { outcome: "SKIPPED", reason: gate.reason };
  }

  const r = renderSource(loaded.input);
  const chunks = chunkSections(r.sections);
  const hash = sha(JSON.stringify({ context: r.context, sections: r.sections, categories: r.categories, sensitive: r.sensitiveCategory, audience: r.audience, handwritten: r.handwritten }));
  const latest = await prisma.ragDocument.findFirst({ where: { sourceType: ref.sourceType, sourceId: ref.sourceId }, orderBy: { sourceVersion: "desc" }, select: { id: true, sourceVersion: true, contentHash: true, status: true } });
  const supersedeOthers = async () => {
    if (!loaded.supersedes.length) return;
    await prisma.$transaction(async (tx) => { for (const s of loaded.supersedes) await retire(tx, s, "AMENDED"); });
  };
  if (latest && latest.contentHash === hash && latest.status === "ACTIVE") {
    await supersedeOthers();
    return { outcome: "UNCHANGED" };
  }
  const version = Math.max(loaded.version ?? 0, (latest?.sourceVersion ?? 0) + 1);

  const owner = loaded.owner;
  const personId = owner.kind === "PERSON" ? owner.personId
    : (await prisma.personPatientLink.findFirst({ where: { patientId: owner.patientId, facilityId: owner.facilityId, status: "ACTIVE" }, select: { personId: true } }))?.personId ?? null;
  const spaces = await writableSpaces();
  const active = spaces.find((s) => s.status === "ACTIVE")!;
  const texts = chunks.map((c) => chunkEmbeddingText({ context: r.context, heading: c.heading, text: c.text }));
  // Provider calls outside the transaction.
  const vectors = await Promise.all(spaces.map((s) => computeEmbeddings(s, texts, gate.permit)));

  const ownerCols = owner.kind === "PERSON"
    ? { ownerType: "PERSON" as const, personId, facilityId: null, patientId: null }
    : { ownerType: "FACILITY_PATIENT" as const, facilityId: owner.facilityId, patientId: owner.patientId, personId };
  const done = await prisma.$transaction(async (tx) => {
    // Stale write: someone indexed a newer version meanwhile.
    const now = await tx.ragDocument.findFirst({ where: { sourceType: ref.sourceType, sourceId: ref.sourceId }, orderBy: { sourceVersion: "desc" }, select: { id: true } });
    if ((now?.id ?? null) !== (latest?.id ?? null)) return false;
    const doc = await tx.ragDocument.create({
      data: {
        ...ownerCols, organizationId: owner.kind === "FACILITY" ? owner.organizationId : null, encounterId: owner.kind === "FACILITY" ? owner.encounterId ?? null : null,
        sourceType: ref.sourceType, sourceId: ref.sourceId, sourceVersion: version, origin: r.origin, originalLanguage: loaded.language ?? "en", contentHash: hash,
        categories: r.categories, sensitiveCategory: r.sensitiveCategory, audience: r.audience, title: r.title, handwritten: r.handwritten, recordedAt: r.recordedAt,
        indexedFromEventId: opts.eventId ?? null, embeddingModel: active.embeddingModel, embeddingDim: active.dims,
      },
    });
    const created = await tx.ragChunk.createManyAndReturn({
      data: chunks.map((c, i) => ({
        documentId: doc.id, chunkNo: i, ...ownerCols, categories: r.categories, sensitiveCategory: r.sensitiveCategory, origin: r.origin, audience: r.audience,
        sourceType: ref.sourceType, sourceId: ref.sourceId, recordedAt: r.recordedAt, handwritten: r.handwritten, context: r.context, heading: c.heading ?? null, text: c.text, tokenCount: c.tokenCount,
      })),
      select: { id: true, chunkNo: true },
    });
    created.sort((a, b) => a.chunkNo - b.chunkNo);
    for (const [si, space] of spaces.entries()) {
      await writeEmbeddings(tx, space, created.map((c, i) => ({ chunkId: c.id, vector: vectors[si][i], ownerType: ownerCols.ownerType, facilityId: ownerCols.facilityId, patientId: ownerCols.patientId, personId: ownerCols.personId })));
    }
    await retire(tx, ref, "AMENDED", doc.id);
    for (const s of loaded.supersedes) await retire(tx, s, "AMENDED");
    return true;
  });
  return { outcome: done ? "INDEXED" : "STALE" };
}

// ── Owners: links, consent, closure ──────────────────────────────────────────

/** A facility record's documents carry its Person while the link is ACTIVE (§3.1); set or cleared here (§5.6). */
export async function setPersonOnFacilityIndex(facilityId: string, patientId: string, personId: string | null): Promise<number> {
  const where = { ownerType: "FACILITY_PATIENT" as const, facilityId, patientId };
  return prisma.$transaction(async (tx) => {
    const n = (await tx.ragDocument.updateMany({ where, data: { personId } })).count;
    await tx.ragChunk.updateMany({ where, data: { personId } });
    await tx.ragEmbedding.updateMany({ where, data: { personId } });
    return n;
  });
}

/** Everything the AI holds for a Person: their own documents and their linked facility records' (§4.2, §5.6). */
export async function removePersonAiIndex(personId: string): Promise<number> {
  const links = await prisma.personPatientLink.findMany({ where: { personId, status: { in: ["ACTIVE", "REVERIFICATION_REQUIRED", "PENDING_VERIFICATION"] } }, select: { facilityId: true, patientId: true } });
  return prisma.$transaction(async (tx) => {
    let n = await removeOwnerIndex(tx, { personId });
    for (const l of links) n += await removeOwnerIndex(tx, { facilityId: l.facilityId, patientId: l.patientId });
    return n;
  });
}

// ── Sources of a record (backfill, re-grant) ─────────────────────────────────

export async function sourcesOfPatient(patientId: string): Promise<SourceRef[]> {
  const encounters = await prisma.encounter.findMany({ where: { patientId }, select: { id: true } });
  const enc = encounters.map((e) => e.id);
  const [notes, labs, imaging, diagnoses, problems, allergies, status, vitals, referrals, discharges, docs] = await Promise.all([
    prisma.clinicalNote.findMany({ where: { encounterId: { in: enc }, status: { in: ["SIGNED", "AMENDED"] } }, select: { id: true } }),
    prisma.labResult.findMany({ where: { labOrder: { patientId }, isCurrent: true, status: { in: ["VERIFIED", "AMENDED"] } }, select: { id: true } }),
    prisma.imagingReport.findMany({ where: { imagingOrder: { patientId }, isCurrent: true, status: { in: ["VERIFIED", "AMENDED"] } }, select: { id: true } }),
    prisma.diagnosis.findMany({ where: { patientId, status: { not: "ENTERED_IN_ERROR" } }, select: { id: true } }),
    prisma.problem.findMany({ where: { patientId }, select: { id: true } }),
    prisma.allergy.findMany({ where: { patientId, source: "CLINICIAN", status: { not: "ENTERED_IN_ERROR" } }, select: { id: true } }),
    prisma.allergyStatusEntry.count({ where: { patientId } }),
    prisma.vital.findMany({ where: { encounterId: { in: enc } }, select: { encounterId: true, recordedAt: true } }),
    prisma.referral.findMany({ where: { patientId, status: { not: "DRAFT" } }, select: { id: true } }),
    prisma.discharge.findMany({ where: { admission: { encounter: { patientId } }, dischargedAt: { not: null } }, select: { id: true } }),
    prisma.clinicalDocument.findMany({ where: { patientId, uploadedByUserId: null, status: "CURRENT" }, select: { id: true, generatedDocumentId: true } }),
  ]);
  const days = new Map<string, SourceRef>();
  for (const v of vitals) { const s = vitalsDaySource(v.encounterId, v.recordedAt); days.set(s.sourceId, s); }
  return [
    ...notes.map((x) => ({ sourceType: "CLINICAL_NOTE" as const, sourceId: x.id })),
    ...labs.map((x) => ({ sourceType: "LAB_RESULT" as const, sourceId: x.id })),
    ...imaging.map((x) => ({ sourceType: "IMAGING_REPORT" as const, sourceId: x.id })),
    ...diagnoses.map((x) => ({ sourceType: "DIAGNOSIS" as const, sourceId: x.id })),
    ...problems.map((x) => ({ sourceType: "PROBLEM" as const, sourceId: x.id })),
    ...allergies.map((x) => ({ sourceType: "ALLERGY" as const, sourceId: x.id })),
    ...(status ? [{ sourceType: "ALLERGY_STATUS" as const, sourceId: patientId }] : []),
    ...days.values(),
    ...referrals.map((x) => ({ sourceType: "REFERRAL" as const, sourceId: x.id })),
    ...discharges.map((x) => ({ sourceType: "DISCHARGE_SUMMARY" as const, sourceId: x.id })),
    ...docs.map((x) => ({ sourceType: (x.generatedDocumentId ? "GENERATED_DOCUMENT" : "CLINICAL_DOCUMENT") as "GENERATED_DOCUMENT" | "CLINICAL_DOCUMENT", sourceId: x.id })),
  ];
}

export async function sourcesOfPerson(personId: string): Promise<SourceRef[]> {
  const [records, documents] = await Promise.all([
    prisma.patientProvidedRecord.findMany({ where: { personId, status: "ACTIVE" }, select: { id: true } }),
    prisma.personDocument.findMany({ where: { personId, status: "CURRENT", type: { not: "ID_PROOF" } }, select: { id: true } }),
  ]);
  return [...records.map((x) => ({ sourceType: "PATIENT_PROVIDED_RECORD" as const, sourceId: x.id })), ...documents.map((x) => ({ sourceType: "PATIENT_DOCUMENT" as const, sourceId: x.id }))];
}

/** The whole record of a Person (theirs, and their ACTIVE links'), through the indexer's own function. */
export async function reindexPerson(personId: string): Promise<{ indexed: number }> {
  const links = await prisma.personPatientLink.findMany({ where: { personId, status: "ACTIVE" }, select: { patientId: true } });
  let indexed = 0;
  for (const ref of [...(await sourcesOfPerson(personId)), ...(await Promise.all(links.map((l) => sourcesOfPatient(l.patientId)))).flat()]) {
    if ((await indexSource(ref)).outcome === "INDEXED") indexed += 1;
  }
  return { indexed };
}

/**
 * After the lapse window (ai.lapsed_consent_index_days, 90), the index of a
 * Person whose AI consent lapsed at 18 and who hasn't chosen again goes, as
 * for a withdrawal (§11.3).
 */
export async function purgeLapsedAiIndexes(opts: { now?: Date; days?: number } = {}): Promise<{ purged: number }> {
  const cutoff = new Date((opts.now ?? new Date()).getTime() - (opts.days ?? 90) * 86_400_000);
  const lapsed = await prisma.personConsent.findMany({ where: { purpose: "AI_ASSISTANCE", status: "LAPSED", lapsedAt: { lt: cutoff } }, select: { personId: true }, distinct: ["personId"] });
  let purged = 0;
  for (const { personId } of lapsed) {
    const since = await prisma.personConsent.count({ where: { personId, purpose: "AI_ASSISTANCE", status: "ACTIVE" } });
    if (since) continue;
    purged += await removePersonAiIndex(personId);
  }
  return { purged };
}
