/**
 * The tenancy sweep's PERSON segment, stated exactly.
 *
 * A person-scoped row belongs to no facility, so no hospital route may return
 * one — EXCEPT a row the person addressed to that facility, which that
 * facility (and only that facility) holds by design:
 *
 *   CardShare          a card shared with one facility for one visit
 *                      (recipientFacilityId); the facility's check-in and
 *                      claim rows carry its id
 *   InsuranceCard      the card of such a share (its id is on the facility's
 *                      pre-authorization and claim)
 *   AccessRequest      a request this facility made (requesterFacilityId)
 *   RecordShare        a share made out to this facility (recipientFacilityId)
 *   Person             a Person linked to one of this facility's records
 *                      (PersonPatientLink is the facility's row and names it)
 *   PersonDocument     an upload of such a Person who chose, at some time, to
 *                      share uploads with the hospitals treating them (or
 *                      shared UPLOADS with this facility, or uploaded it to
 *                      this facility before Phase 0): the facility's
 *                      DOCUMENT_REVIEW task names it
 *   Patient (another   a record whose patient redeemed a visit code with a
 *   facility's)        doctor of this facility (PatientAccessSession.facilityId):
 *                      the session's events are this facility's and name it
 *
 * Every other person-scoped row, and each of these for every OTHER facility,
 * stays forbidden. The sweep used to forbid them all, to everyone: correct
 * only while no gate before it had created an addressed row, so its result
 * depended on the order of the gates (found 2026-11-17: 23 false failures
 * when the insurance gates ran first).
 */
import { prisma } from "../../src/lib/db";

export async function addressedTo(facilityIds: string[]): Promise<Set<string>> {
  const ids = new Set<string>();
  const cardShares = await prisma.cardShare.findMany({ where: { recipientFacilityId: { in: facilityIds } }, select: { id: true, cardId: true } });
  for (const s of cardShares) { ids.add(s.id); ids.add(s.cardId); }
  for (const r of await prisma.accessRequest.findMany({ where: { requesterFacilityId: { in: facilityIds } }, select: { id: true } })) ids.add(r.id);
  const shares = await prisma.recordShare.findMany({ where: { recipientFacilityId: { in: facilityIds } }, select: { id: true, personId: true, categories: true } });
  for (const s of shares) ids.add(s.id);
  const links = await prisma.personPatientLink.findMany({ where: { facilityId: { in: facilityIds } }, select: { personId: true } });
  const linked = [...new Set(links.map((l) => l.personId))];
  for (const p of linked) ids.add(p);
  if (linked.length) {
    const chose = new Set((await prisma.personConsent.findMany({ where: { personId: { in: linked }, purpose: "SHARE_UPLOADS_WITH_TREATING", decision: "GRANTED" }, select: { personId: true } })).map((c) => c.personId));
    for (const s of shares) if (s.categories.includes("UPLOADS")) chose.add(s.personId);
    const docs = await prisma.personDocument.findMany({ where: { personId: { in: linked }, OR: [{ personId: { in: [...chose] } }, { legacyFacilityId: { in: facilityIds } }] }, select: { id: true } });
    for (const d of docs) ids.add(d.id);
  }
  for (const s of await prisma.patientAccessSession.findMany({ where: { facilityId: { in: facilityIds } }, select: { patientId: true } })) ids.add(s.patientId);
  return ids;
}
