import type { ProxyPermission } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { resolvePatientIdsForRead } from "@/lib/patient/merge";
import { shareHistory } from "@/lib/sharing/history";
import type { ShareScope } from "@/lib/sharing/resolve";
import { issueAccessCode } from "@/lib/patient/accessSession";
import { parseShareChoice } from "@/lib/sharing/categories";
import { listInsurance } from "@/lib/patient/experience/insurance";
import { requireProxy, type ProxyAccess } from "./grants";

/**
 * Week 5b — what a proxy does for a member, each through its permission
 * (docs/HOUSEHOLD_DESIGN.md §5). The request names the member (the profile
 * switcher changes the subject, never the actor); every call re-checks the
 * grant. Every proxy action is written to the member's access log (via PROXY,
 * with the proxy's Person), so an adult member sees it.
 *
 *   VIEW       the member's record within the grant's categories and
 *              sensitive opt-ins (the same filters as a 4c share; uploads and
 *              patient-provided entries only with UPLOADS)
 *   UPLOAD     upload to the member's Person and review the extracted facts
 *              (facts confirmed by a proxy are labelled "confirmed by proxy")
 *   BOOK       book through the directory for the member (doctors/booking.ts)
 *   SHARE      issue the member's visit code, within the proxy's own
 *              categories and opt-ins (a proxy never shares more than they see)
 *   INSURANCE  the member's coverage and claims
 *   USE_AI     the patient-audience AI modes over what VIEW allows (rag/access.ts)
 */
export async function logProxy(p: ProxyAccess, actorUserId: string, action: string, detail: Record<string, unknown> = {}) {
  await prisma.personAccessLogEntry.create({ data: { personId: p.memberPersonId, kind: "PROXY_ACTION", actorUserId, detail: { via: "PROXY", proxyPersonId: p.proxyPersonId, action, ...detail } as never } });
}

/** The member's ACTIVE facility records (merge-aware). */
export async function memberRecords(memberPersonId: string) {
  const links = await prisma.personPatientLink.findMany({ where: { personId: memberPersonId, status: "ACTIVE" }, select: { patientId: true, facilityId: true }, orderBy: { createdAt: "asc" } });
  const patientIds = [...new Set((await Promise.all(links.map((l) => resolvePatientIdsForRead(l.patientId)))).flat())];
  return { links, patientIds, facilityIds: [...new Set(links.map((l) => l.facilityId))] };
}

/** A grant as a read scope, for the shared-history filters. */
export async function grantScope(p: ProxyAccess): Promise<ShareScope | null> {
  const r = await memberRecords(p.memberPersonId);
  const subject = r.links[0]?.patientId;
  if (!subject) return null;
  return {
    ref: p.grant.id, shareId: null, sessionId: null, via: "SHARE_CODE", legacy: false, personId: p.memberPersonId, subjectPatientId: subject,
    patientIds: r.patientIds, facilityIds: r.facilityIds, categories: p.categories, sensitive: p.sensitive, recordedFrom: null, recordedTo: null, expiresAt: null,
  };
}

/** VIEW: the member's record as the grant allows. A member with no hospital record yet shows their uploads only. */
export async function viewMember(proxyUserId: string, memberPersonId: string) {
  const p = await requireProxy(proxyUserId, memberPersonId, "VIEW");
  const scope = await grantScope(p);
  const person = await prisma.person.findUniqueOrThrow({ where: { id: memberPersonId }, select: { displayName: true, dateOfBirth: true } });
  await logProxy(p, proxyUserId, "VIEW");
  if (!scope) {
    const docs = p.categories.includes("UPLOADS") ? await prisma.personDocument.findMany({ where: { personId: memberPersonId, status: "CURRENT", type: { not: "ID_PROOF" } }, orderBy: { uploadedAt: "desc" }, take: 50 }) : [];
    const { sharedDocumentVisible } = await import("@/lib/sharing/history");
    const fake = { categories: p.categories, sensitive: p.sensitive, personId: memberPersonId, recordedFrom: null, recordedTo: null } as unknown as ShareScope;
    return { member: { name: person.displayName }, categories: p.categories, permissions: p.grant.permissions, record: null, uploads: docs.filter((d) => sharedDocumentVisible(fake, d)).map((d) => ({ id: d.id, title: d.title, uploadedAt: d.uploadedAt.toISOString() })) };
  }
  const h = await shareHistory(scope);
  return { member: { name: person.displayName }, categories: p.categories, permissions: p.grant.permissions, record: h, uploads: h?.uploads?.documents ?? [] };
}

/** UPLOAD: a document to the member's Person, as the proxy. */
export async function uploadForMember(proxyUserId: string, memberPersonId: string, input: { bytes: Buffer; contentType: string; originalName: string; title: string; type: string }) {
  const p = await requireProxy(proxyUserId, memberPersonId, "UPLOAD");
  const { uploadPersonDocumentFor } = await import("@/lib/person/documents");
  const doc = await uploadPersonDocumentFor(memberPersonId, proxyUserId, input);
  await logProxy(p, proxyUserId, "UPLOAD", { documentId: doc.id });
  return doc;
}

/** BOOK: a directory booking for the member (their record at that facility, their share). */
export async function bookForMember(proxyUserId: string, memberPersonId: string, body: Record<string, unknown>) {
  const p = await requireProxy(proxyUserId, memberPersonId, "BOOK");
  // A share attached to a booking is a SHARE too: only with SHARE, within the proxy's categories.
  if (body.share) await assertCanShare(proxyUserId, memberPersonId, body.share as Record<string, unknown>);
  const { bookForPerson } = await import("@/lib/doctors/booking");
  const out = await bookForPerson(proxyUserId, memberPersonId, body);
  await logProxy(p, proxyUserId, "BOOK", { appointmentId: out.appointmentId, shared: !!out.shareId });
  return out;
}

async function assertCanShare(proxyUserId: string, memberPersonId: string, body: Record<string, unknown>) {
  const s = await requireProxy(proxyUserId, memberPersonId, "SHARE");
  const v = await proxyGrantView(proxyUserId, memberPersonId);
  const choice = parseShareChoice(body, { categories: s.categories });
  if (choice.categories.some((c) => !v.categories.includes(c))) throw new BadRequestError("You can only share what you can see.");
  if (choice.sensitiveCategories.some((c) => !v.sensitive.includes(c))) throw new BadRequestError("You can only share what you can see.");
  return { s, choice };
}

/** What the proxy can see (VIEW), which bounds what they may share. */
async function proxyGrantView(proxyUserId: string, memberPersonId: string) {
  const v = await requireProxy(proxyUserId, memberPersonId, "VIEW");
  return { categories: v.categories, sensitive: v.sensitive };
}

/** SHARE: the member's visit code, within what the proxy can see. */
export async function issueCodeForMember(proxyUserId: string, memberPersonId: string, body: Record<string, unknown>) {
  const { s, choice } = await assertCanShare(proxyUserId, memberPersonId, body);
  const r = await memberRecords(memberPersonId);
  const patientId = typeof body.patientId === "string" ? body.patientId : r.links[0]?.patientId;
  if (!patientId || !r.links.some((l) => l.patientId === patientId)) throw new NotFoundError();
  const validHours = body.validHours === undefined ? undefined : Number(body.validHours);
  const out = await issueAccessCode(patientId, proxyUserId, "Shared by a family member", { choice, validHours });
  await logProxy(s, proxyUserId, "SHARE", { shareId: out.session.shareId });
  await recordAuditEvent("household.proxy.shared", proxyUserId, { memberPersonId, shareId: out.session.shareId });
  return out;
}

/** INSURANCE: the member's coverage and claims. */
export async function insuranceForMember(proxyUserId: string, memberPersonId: string) {
  const p = await requireProxy(proxyUserId, memberPersonId, "INSURANCE");
  const r = await memberRecords(memberPersonId);
  const out = [];
  for (const l of r.links) {
    const ids = await resolvePatientIdsForRead(l.patientId);
    out.push({ facilityId: l.facilityId, ...(await listInsurance({ patientId: l.patientId, patientIds: ids, facilityId: l.facilityId, isSelf: false, allowedClasses: new Set(["INSURANCE"]) })) });
  }
  await logProxy(p, proxyUserId, "INSURANCE");
  return { records: out };
}

export const PERMISSION_LABEL: Record<ProxyPermission, string> = {
  VIEW: "See the record", UPLOAD: "Upload and review documents", BOOK: "Book appointments", SHARE: "Share the record with a doctor", INSURANCE: "Insurance", USE_AI: "Use the AI assistant",
};
