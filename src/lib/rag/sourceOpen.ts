import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { AiAccessError, resolveAiAccess, type AiActor } from "./access";
import { AskError } from "./ask";
import { scopeSql } from "./search";
import { hitsFor } from "./knowledgeSearch";
import { knowledgeClassesFor } from "./knowledgeAccess";
import { isoDay } from "./render";

/**
 * RAG Phase 5, step 5.8 — GET /api/ai/sources/:id (docs/RAG_ARCHITECTURE.md
 * §13.4, §16): a citation, opened. `id` is the AiInteractionSource row (the
 * durable record of what an answer rested on; it holds no text). The source
 * opens only for a caller who may read it NOW, checked again, whatever was
 * true when the answer was given:
 *
 *   a record source     the access resolver, now, for this caller and the
 *                       answer's patient (and its share, if it came through
 *                       one): the chunk must be inside the scope SQL; a live
 *                       fact (a medicine, an allergy, a dose) must still be
 *                       the caller's to see, re-read from its table
 *   a knowledge source  the caller's organisation, facility and access
 *                       classes, now; the version still in force
 *
 * Anything else is 404, the same answer as for a source that never existed:
 * an id reveals nothing to someone who may not read it. Every response is
 * no-store (the route).
 */
export interface OpenedSource { sourceType: string; sourceId: string; title: string; text: string; origin: string; recordedAt: string; link: string | null }

const NOT_FOUND = () => new AskError(404, "NOT_FOUND");

export async function openSource(actor: AiActor, id: string): Promise<OpenedSource> {
  const row = await prisma.aiInteractionSource.findUnique({ where: { id }, include: { interaction: { select: { patientId: true, shareId: true, organizationId: true } } } });
  if (!row) throw NOT_FOUND();

  if (row.sourceType === "KNOWLEDGE_DOCUMENT") {
    if (actor.kind !== "STAFF" || !row.chunkId) throw NOT_FOUND();
    const fac = await prisma.facility.findUnique({ where: { id: actor.facilityId }, select: { organizationId: true } });
    if (!fac) throw NOT_FOUND();
    const [hit] = await hitsFor({ organizationId: fac.organizationId, facilityId: actor.facilityId, accessClasses: knowledgeClassesFor(actor.role) }, [{ chunkId: row.chunkId, score: 0 }]);
    if (!hit) throw NOT_FOUND();
    return { sourceType: row.sourceType, sourceId: row.sourceId, title: `${hit.title}${hit.sectionPath ? ` · ${hit.sectionPath}` : ""} · version ${hit.version}`, text: hit.text, origin: "VERIFIED", recordedAt: (hit.publishedAt ?? row.recordedAt).toISOString(), link: `/hospital-os/knowledge?document=${hit.knowledgeDocumentId}` };
  }

  const patientId = row.interaction.patientId;
  if (!patientId) throw NOT_FOUND();
  let access;
  try {
    access = await resolveAiAccess(actor, { mode: actor.kind === "STAFF" ? "CHART_QA" : "HEALTH_TIMELINE", patientId, ...(row.interaction.shareId ? { shareId: row.interaction.shareId } : {}) });
  } catch (err) {
    if (err instanceof AiAccessError) throw NOT_FOUND();
    throw err;
  }
  const link = actor.kind === "STAFF" ? `/hospital-os/doctor/patients/${patientId}?entry=${row.sourceType}:${row.sourceId}` : `/patient/records?entry=${row.sourceType}:${row.sourceId}`;

  // A live fact: re-read from its own table, inside the caller's live scope.
  if (row.chunkId?.startsWith("live:")) {
    const { patientIds, facilityIds } = access.live;
    if (row.sourceType === "MEDICATION_ORDER" && access.live.medications) {
      const o = await prisma.medicationOrder.findFirst({ where: { id: row.sourceId, patientId: { in: patientIds }, encounter: { facilityId: { in: facilityIds } } }, select: { drugName: true, dose: true, route: true, frequency: true, orderedAt: true, status: true } });
      if (o) return { sourceType: row.sourceType, sourceId: row.sourceId, title: `Medicine · ${o.drugName} · ${isoDay(o.orderedAt)}`, text: `${o.drugName} ${o.dose} ${o.route.toLowerCase()} ${o.frequency} (${o.status.toLowerCase().replace(/_/g, " ")}).`, origin: "VERIFIED", recordedAt: o.orderedAt.toISOString(), link };
    }
    if (row.sourceType === "ALLERGY" && access.live.allergies) {
      const a = await prisma.allergy.findFirst({ where: { id: row.sourceId, patientId: { in: patientIds }, patient: { facilityId: { in: facilityIds } }, ...(access.live.patientProvidedAllergies ? {} : { source: "CLINICIAN" }) }, select: { substance: true, reaction: true, severity: true, status: true, recordedAt: true, source: true } });
      if (a) return { sourceType: row.sourceType, sourceId: row.sourceId, title: `Allergy · ${a.substance} · ${isoDay(a.recordedAt)}`, text: `${a.substance}${a.reaction ? `, reaction ${a.reaction}` : ""}${a.severity ? `, ${a.severity.toLowerCase()}` : ""} (${a.status.toLowerCase()}).`, origin: a.source === "PATIENT_PROVIDED" ? "PATIENT_PROVIDED" : "VERIFIED", recordedAt: a.recordedAt.toISOString(), link };
    }
    if (row.sourceType === "MEDICATION_DOSE" && access.live.nurseView) {
      const d = await prisma.medicationAdministration.findFirst({ where: { id: row.sourceId, medicationOrder: { patientId: { in: patientIds }, encounter: { facilityId: { in: facilityIds } } } }, select: { status: true, scheduledAt: true, medicationOrder: { select: { drugName: true, dose: true } } } });
      if (d) return { sourceType: row.sourceType, sourceId: row.sourceId, title: `Medicine dose · ${d.medicationOrder.drugName} · ${isoDay(d.scheduledAt)}`, text: `${d.medicationOrder.drugName} ${d.medicationOrder.dose}, ${d.status.toLowerCase()} at ${d.scheduledAt.toISOString().slice(11, 16)} UTC on ${isoDay(d.scheduledAt)}.`, origin: "VERIFIED", recordedAt: d.scheduledAt.toISOString(), link };
    }
    throw NOT_FOUND();
  }

  // An indexed chunk: through the scope SQL, now. If the chunk was replaced (the source re-indexed), its source's
  // current chunk, still through the scope.
  const pick = (where: Prisma.Sql) => prisma.$queryRaw<{ context: string; text: string; origin: string; recordedAt: Date }[]>(Prisma.sql`
    SELECT c."context", c."text", c."origin"::text AS "origin", c."recordedAt" FROM "RagChunk" c WHERE ${scopeSql(access.scope)} AND ${where} ORDER BY c."chunkNo" LIMIT 1`);
  const [chunk] = row.chunkId ? await pick(Prisma.sql`c."id" = ${row.chunkId}`) : [];
  const [current] = chunk ? [chunk] : await pick(Prisma.sql`c."sourceType"::text = ${row.sourceType} AND c."sourceId" = ${row.sourceId}`);
  if (!current) throw NOT_FOUND();
  return { sourceType: row.sourceType, sourceId: row.sourceId, title: current.context.replace(/^\[|\]$/g, ""), text: current.text, origin: current.origin, recordedAt: current.recordedAt.toISOString(), link };
}
