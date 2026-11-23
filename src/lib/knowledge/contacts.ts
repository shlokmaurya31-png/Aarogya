import type { FacilityContactKind } from "@prisma/client";
import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitDomainEvent } from "@/lib/events/emit";
import { normalizeMobile } from "./identifiers";
import { KnowledgeError } from "./errors";
import type { KnowledgeActor } from "./service";

/**
 * Decisions before Phase 3 (docs/RAG_IMPLEMENTATION_PLAN.md §13.4 C) — a
 * facility's published mobile numbers: the switchboard, helplines, the
 * ambulance. A knowledge document may print these without a highlight. The
 * hospital administrator (knowledge:manage) edits the list for their own
 * facility; every change is audited and emitted, and a removed number keeps
 * its row with who removed it. These are the hospital's public numbers,
 * never a patient's.
 */
export const CONTACT_KINDS: FacilityContactKind[] = ["SWITCHBOARD", "HELPLINE", "AMBULANCE", "OTHER"];

export async function listFacilityContacts(actor: Pick<KnowledgeActor, "facilityId" | "organizationId">) {
  return prisma.facilityPublishedContact.findMany({
    where: { facilityId: actor.facilityId, organizationId: actor.organizationId, removedAt: null },
    orderBy: [{ kind: "asc" }, { addedAt: "asc" }],
    select: { id: true, kind: true, label: true, number: true, addedAt: true },
  });
}

export async function addFacilityContact(actor: KnowledgeActor, input: { kind?: string; label?: string; number?: string }) {
  const kind = input.kind as FacilityContactKind;
  if (!CONTACT_KINDS.includes(kind)) throw new KnowledgeError(400, "INVALID", "Choose what the number is for.");
  const label = (input.label ?? "").trim();
  if (label.length < 2 || label.length > 80) throw new KnowledgeError(400, "INVALID", "A label of 2 to 80 characters is required.");
  const number = normalizeMobile(input.number ?? "");
  if (!number) throw new KnowledgeError(400, "INVALID", "Enter a ten-digit Indian mobile number (landlines and toll-free numbers never need listing).");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Facility" WHERE "id" = ${actor.facilityId} FOR UPDATE`;
    if (await tx.facilityPublishedContact.findFirst({ where: { facilityId: actor.facilityId, number, removedAt: null }, select: { id: true } })) {
      throw new KnowledgeError(409, "CONTACT_EXISTS", "This number is already on the list.");
    }
    const c = await tx.facilityPublishedContact.create({ data: { organizationId: actor.organizationId, facilityId: actor.facilityId, kind, label, number, addedByUserId: actor.userId }, select: { id: true, kind: true, label: true, number: true, addedAt: true } });
    await emitDomainEvent(tx, { type: "FacilityContactPublished", aggregateId: actor.facilityId, organizationId: actor.organizationId, facilityId: actor.facilityId, actorUserId: actor.userId, payload: { contactId: c.id, kind } });
    await recordAuditEvent("knowledge.contact.added", actor.userId, { contactId: c.id, kind, label, number }, { facilityId: actor.facilityId, organizationId: actor.organizationId }, tx);
    return c;
  });
}

export async function removeFacilityContact(actor: KnowledgeActor, contactId: string, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    const c = await tx.facilityPublishedContact.findFirst({ where: { id: contactId, facilityId: actor.facilityId, organizationId: actor.organizationId, removedAt: null }, select: { id: true, kind: true, label: true, number: true } });
    if (!c) throw new NotFoundError();
    await tx.facilityPublishedContact.update({ where: { id: c.id }, data: { removedAt: now, removedByUserId: actor.userId } });
    await emitDomainEvent(tx, { type: "FacilityContactRemoved", aggregateId: actor.facilityId, organizationId: actor.organizationId, facilityId: actor.facilityId, actorUserId: actor.userId, payload: { contactId: c.id } });
    await recordAuditEvent("knowledge.contact.removed", actor.userId, { contactId: c.id, kind: c.kind, label: c.label, number: c.number }, { facilityId: actor.facilityId, organizationId: actor.organizationId }, tx);
    return { contactId: c.id };
  });
}
