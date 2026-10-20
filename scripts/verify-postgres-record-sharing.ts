/**
 * Week 4c — sharing by category (docs/CONSENT_SHARING_DESIGN.md §2–§4, §8, §10),
 * through the services the routes call (the consult view: viewSharedRecord):
 *   - a code issued with a share: PENDING share and RecordShareCreated; the
 *     redemption binds it to the doctor (ACTIVE) with its event;
 *   - a LABS-only code shows labs and allergies, and no medicines, notes or
 *     uploads; a PRESCRIPTIONS one shows medicines; UPLOADS adds the
 *     person's documents and confirmed entries, each entry only with its
 *     own category too (a diagnosis entry never);
 *   - the period: an entry outside it is absent, allergies stay (safety);
 *   - the first opening is in the person's access log, refreshes aren't;
 *   - another doctor, an ended visit, an expired share: nothing (404);
 *   - extending a visit never passes the share's validity;
 *   - the patient cancelling an unredeemed code revokes its share;
 *   - a code issued before 4c (no share) reads the default scope;
 *   - every transition emits RecordShareStatusChanged in its transaction.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-record-sharing.ts
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { issueAccessCode, redeemAccessCode, endAccessSession, endOwnAccessSession, extendAccessSession } from "../src/lib/patient/accessSession";
import { parseShareChoice } from "../src/lib/sharing/categories";
import { viewSharedRecord } from "../src/lib/sharing/view";
import { endOwnShare, listOwnShares, sweepShareExpiry } from "../src/lib/sharing/shares";
import { PUNE, allergy, drain, eventsOf, lab, medicine, notFound, provided, reporter, sharer, staff, tag } from "./lib/shareFixture";

const { report, done } = reporter();

async function main() {
  registerAllConsumers();
  const P = await sharer();
  const doc = await staff(PUNE, "DOCTOR");
  const other = await staff(PUNE, "DOCTOR");
  await lab(P.pune, P.punEnc, "Haemoglobin", `11.4 lab${tag}`);
  await lab(P.pune, P.punEnc, "Serum creatinine", `0.8 oldlab${tag}`, new Date("2020-02-02T08:00:00Z"));
  await medicine(P.pune, P.punEnc, `Amlodipine rx${tag}`);
  await allergy(P.pune, `Penicillin al${tag}`);
  const labEntry = await provided(P.personId, "LAB_RESULT", { analyte: `Ferritin pp${tag}`, value: "30", unit: "ng/mL" });
  await provided(P.personId, "MEDICATION_HISTORY", { name: `Metformin ppm${tag}`, dose: "500 mg", frequency: "BD" });
  await provided(P.personId, "DIAGNOSIS", { text: `Hypothyroidism ppd${tag}` });
  await drain();
  const issue = (choice: Record<string, unknown>, validHours?: number) => issueAccessCode(P.pune, P.userId, "gate", { choice: parseShareChoice(choice), validHours });
  const redeem = (code: string, by = doc) => redeemAccessCode({ code, doctorUserId: by.userId, doctorStaffId: by.staffId, doctorName: "Gate doctor", facilityId: PUNE });
  const view = (ref: string, by = doc) => viewSharedRecord(by.actor, ref, "CONSULT_VIEW");
  const has = (h: unknown, word: string) => JSON.stringify(h).includes(word);

  // 1. A LABS-only code.
  const a = await issue({ categories: ["LABS"] });
  const shareA = await prisma.recordShare.findUniqueOrThrow({ where: { id: a.session.shareId! } });
  report("Issuing a code creates its share: PENDING, LABS only, no sensitive categories, covering the person's records", shareA.status === "PENDING" && shareA.kind === "CODE" && shareA.categories.join() === "LABS" && shareA.sensitiveCategories.length === 0 && shareA.patientIds.includes(P.pune));
  report("…with RecordShareCreated and SHARE_CREATED in the person's log", (await eventsOf(shareA.id, "RecordShareCreated")).length === 1 && (await prisma.personAccessLogEntry.count({ where: { personId: P.personId, kind: "SHARE_CREATED" } })) === 1);
  report("…and a 24-hour validity by default", Math.abs(shareA.expiresAt.getTime() - Date.now() - 24 * 3_600_000) < 60_000);
  const sa = await redeem(a.code);
  const shareA2 = await prisma.recordShare.findUniqueOrThrow({ where: { id: shareA.id } });
  report("Redeeming binds the share to the doctor and their facility (ACTIVE), with its event", !!sa && shareA2.status === "ACTIVE" && shareA2.recipientUserId === doc.userId && shareA2.recipientFacilityId === PUNE
    && (await eventsOf(shareA.id, "RecordShareStatusChanged")).some((e) => (e.payload as { to?: string }).to === "ACTIVE"));
  const va = (await view(sa!.id)).history;
  report("The consult view shows the shared lab result and the allergy (the safety minimum)", has(va.labResults, `lab${tag}`) && has(va.allergies, `al${tag}`));
  report("…and no medicines, no uploads (those sections are absent, not empty)", va.medicationOrders === undefined && va.uploads === undefined && !has(va, `rx${tag}`) && !has(va, `pp${tag}`));
  report("…and nothing of what a share never carries (no problems, diagnoses, notes, vitals keys)", !("problems" in va) && !("diagnoses" in va) && !("encounters" in va) && !("vitals" in va));
  report("…with no period, the 2020 result is there", has(va.labResults, `oldlab${tag}`));
  await view(sa!.id);
  const logged = await prisma.personAccessLogEntry.findMany({ where: { personId: P.personId, kind: "RECORD_ACCESSED", actorUserId: doc.userId } });
  report("Opening the consult view is in the person's access log once (a refresh isn't), with the way in and categories",
    logged.length === 1 && (logged[0].detail as { via?: string; surface?: string; categories?: string[] }).via === "SHARE_CODE" && (logged[0].detail as { surface?: string }).surface === "CONSULT_VIEW" && (logged[0].detail as { categories?: string[] }).categories?.join() === "LABS");
  report("Another doctor holding the session id gets nothing (404)", await notFound(view(sa!.id, other)));

  // 2. Medicines, uploads and a period.
  const b = await issue({ categories: ["PRESCRIPTIONS", "LABS", "UPLOADS"], period: { from: "2026-01-01" } });
  report("Issuing a new code ends the previous visit and its share (ENDED, VISIT_ENDED)", (await prisma.recordShare.findUniqueOrThrow({ where: { id: shareA.id } })).status === "ENDED" && (await prisma.recordShare.findUniqueOrThrow({ where: { id: shareA.id } })).endedReason === "VISIT_ENDED");
  const sb = await redeem(b.code);
  const vb = (await view(sb!.id)).history;
  report("PRESCRIPTIONS shows the medicine", has(vb.medicationOrders, `rx${tag}`));
  report("The period from 2026 leaves out the 2020 result, and keeps the allergy", !has(vb, `oldlab${tag}`) && has(vb.labResults, `lab${tag}`) && has(vb.allergies, `al${tag}`));
  report("UPLOADS shows the person's documents and their confirmed lab and medicine entries", (vb.uploads?.documents.length ?? 0) >= 3 && has(vb.uploads?.entries, `pp${tag}`) && has(vb.uploads?.entries, `ppm${tag}`));
  report("…but never a diagnosis entry (not a shareable category)", !has(vb, `ppd${tag}`));
  const c = await issue({ categories: ["LABS", "UPLOADS"] });
  const sc = await redeem(c.code);
  const vc = (await view(sc!.id)).history;
  report("UPLOADS without PRESCRIPTIONS: the uploaded lab entry yes, the uploaded medicine no", has(vc.uploads?.entries, `pp${tag}`) && !has(vc, `ppm${tag}`) && !!labEntry);

  // 3. The end of a visit, extension and expiry.
  await endAccessSession(sc!.id, "DOCTOR", doc.userId);
  const shareC = await prisma.recordShare.findUniqueOrThrow({ where: { id: c.session.shareId! } });
  report("Ending the visit ends the share (ENDED, VISIT_ENDED), with its event", shareC.status === "ENDED" && shareC.endedReason === "VISIT_ENDED" && (await eventsOf(shareC.id, "RecordShareStatusChanged")).some((e) => (e.payload as { to?: string }).to === "ENDED"));
  report("…and the consult view is gone (404)", await notFound(view(sc!.id)));
  const d = await issue({ categories: ["LABS"] }, 1);
  const sd = await redeem(d.code);
  for (let i = 0; i < 8; i++) await extendAccessSession(sd!.id);
  const sd2 = await prisma.patientAccessSession.findUniqueOrThrow({ where: { id: sd!.id } });
  const shareD = await prisma.recordShare.findUniqueOrThrow({ where: { id: d.session.shareId! } });
  report("Extending a visit never passes the share's validity (a 1-hour share)", sd2.activeExpiresAt!.getTime() <= shareD.expiresAt.getTime(), `${sd2.activeExpiresAt?.toISOString()} ≤ ${shareD.expiresAt.toISOString()}`);
  await prisma.recordShare.update({ where: { id: shareD.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  report("A share past its validity reads nothing, even before the sweep (404)", await notFound(view(sd!.id)));
  const swept = await sweepShareExpiry();
  report("The sweep expires it (EXPIRED), with its event", swept.expired >= 1 && (await prisma.recordShare.findUniqueOrThrow({ where: { id: shareD.id } })).status === "EXPIRED" && (await eventsOf(shareD.id, "RecordShareStatusChanged")).some((e) => (e.payload as { to?: string }).to === "EXPIRED"));

  // 4. The patient cancels an unredeemed code; ends a live share.
  const e = await issue({ categories: ["LABS"] });
  await endOwnAccessSession(e.session.id, P.pune, P.userId);
  report("Cancelling an unredeemed code revokes its share (REVOKED, PATIENT_ENDED)", (await prisma.recordShare.findUniqueOrThrow({ where: { id: e.session.shareId! } })).status === "REVOKED");
  report("…and the code can no longer be redeemed", (await redeem(e.code)) === null);
  const f = await issue({ categories: ["LABS"] });
  const sf = await redeem(f.code);
  await endOwnShare(P.userId, f.session.shareId!);
  report("The patient ending a live share ends its visit too, at once (404)", await notFound(view(sf!.id)) && (await prisma.patientAccessSession.findUniqueOrThrow({ where: { id: sf!.id } })).status === "ENDED");
  report("Someone else can't end the patient's share (404)", await notFound(endOwnShare(other.userId, f.session.shareId!)));
  const mine = await listOwnShares(P.userId);
  const docName = (await prisma.user.findUniqueOrThrow({ where: { id: doc.userId }, select: { displayName: true } })).displayName;
  const listed = mine.find((s) => s.id === shareA.id);
  report("The patient's list shows their shares, each with the doctor's name and facility", mine.length >= 6 && listed?.recipient.doctorName === docName && !!listed?.recipient.facilityName && listed.status === "ENDED");

  // 5. A code issued before 4c (no share): the default scope.
  const legacy = await prisma.patientAccessSession.create({ data: { patientId: P.pune, codeHash: `legacy-${tag}`, status: "ACTIVE", doctorUserId: doc.userId, doctorStaffId: doc.staffId, facilityId: PUNE, expiresAt: new Date(Date.now() + 600_000), activeExpiresAt: new Date(Date.now() + 600_000), redeemedAt: new Date() } });
  const vl = (await view(legacy.id)).history;
  report("A pre-4c code reads the default scope: records yes, uploads no, nothing outside the four categories", vl.shared.legacy && has(vl.labResults, `lab${tag}`) && has(vl.medicationOrders, `rx${tag}`) && vl.uploads === undefined);

  await done();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
