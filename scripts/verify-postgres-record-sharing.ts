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
 *   - a code issued before 4c (no share) reads the legacy scope;
 *   - every transition emits RecordShareStatusChanged in its transaction.
 * 4c fix (§15):
 *   - a code with no choice gets the default: every non-sensitive category,
 *     uploads included, clinical notes not; it shows conditions (diagnoses,
 *     the problem list, a confirmed patient-provided condition), vitals and
 *     uploads, and no note; a sensitive condition only with its opt-in;
 *   - CLINICAL_NOTES only when ticked; unticking UPLOADS removes them;
 *   - a shared upload opens through a 5-minute signed URL, after the access
 *     check, logged (DOCUMENT_DOWNLOAD, with the way in) and audited; never
 *     for another doctor, a share without UPLOADS, an ended share, an upload
 *     outside the period, an ID proof, a withdrawn upload or another person's;
 *     an approved request's doctor can open it too.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-record-sharing.ts
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { issueAccessCode, redeemAccessCode, endAccessSession, endOwnAccessSession, extendAccessSession } from "../src/lib/patient/accessSession";
import { DEFAULT_SHARE_CATEGORIES, parseShareChoice } from "../src/lib/sharing/categories";
import { personDocumentDownload } from "../src/lib/person/documents";
import { decideRequest, requestAccess } from "../src/lib/sharing/requests";
import { verifyDownloadToken } from "../src/lib/storage";
import { viewSharedRecord } from "../src/lib/sharing/view";
import { endOwnShare, listOwnShares, sweepShareExpiry } from "../src/lib/sharing/shares";
import { PUNE, allergy, diagnosis, drain, eventsOf, lab, medicine, note, notFound, problem, provided, reporter, sharer, staff, tag, upload, vital } from "./lib/shareFixture";

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
  report("…and no section it didn't share (conditions, vitals, notes absent), nor what a share never carries (no encounters, raw problems or diagnoses keys)",
    va.conditions === undefined && va.vitals === undefined && va.clinicalNotes === undefined && !("problems" in va) && !("diagnoses" in va) && !("encounters" in va));
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
  report("…but no diagnosis entry without CONDITIONS", !has(vb, `ppd${tag}`));
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
  report("A pre-4c code reads the legacy scope: records yes, uploads no, nothing outside the four categories", vl.shared.legacy && has(vl.labResults, `lab${tag}`) && has(vl.medicationOrders, `rx${tag}`) && vl.uploads === undefined
    && vl.conditions === undefined && vl.vitals === undefined && vl.clinicalNotes === undefined);

  // 6. The 4c fix: the default share, the new categories, and opening uploads.
  const Q = await sharer();
  await diagnosis(Q.pune, Q.punEnc, `Osteoarthritis right knee dx${tag}`, { code: "M17.11" });
  await problem(Q.pune, `Hypertension pl${tag}`, { code: "I10" });
  await diagnosis(Q.pune, Q.punEnc, `Major depressive disorder sdx${tag}`, { code: "F32.9" });
  await vital(Q.punEnc, { hr: 88, sbp: 142, dbp: 91 });
  await note(Q.pune, Q.punEnc, `Knee swelling worse on stairs note${tag}`);
  await allergy(Q.pune, `Sulfa qal${tag}`);
  await provided(Q.personId, "DIAGNOSIS", { text: `Old meniscus tear qpd${tag}` });
  const mri = await upload(Q.personId, `MRI right knee report ${tag}`);
  const idProof = await upload(Q.personId, `Aadhaar ${tag}`, { type: "ID_PROOF" });
  const oldUpload = await upload(Q.personId, `Old X-ray ${tag}`, { uploadedAt: new Date("2019-05-05T00:00:00Z") });
  const withdrawn = await upload(Q.personId, `Withdrawn scan ${tag}`);
  await prisma.personDocument.update({ where: { id: withdrawn }, data: { status: "WITHDRAWN", withdrawnAt: new Date() } });
  const R = await sharer();
  const othersDoc = await upload(R.personId, `Someone else ${tag}`);
  await drain();
  const issueQ = (choice: Record<string, unknown>, defaults = true) => issueAccessCode(Q.pune, Q.userId, "gate", { choice: parseShareChoice(choice, defaults ? { categories: DEFAULT_SHARE_CATEGORIES } : {}) });
  const g = await issueQ({});
  const shareG = await prisma.recordShare.findUniqueOrThrow({ where: { id: g.session.shareId! } });
  report("A code with no choice shares every non-sensitive category, uploads included, clinical notes not, nothing sensitive",
    [...shareG.categories].sort().join() === [...DEFAULT_SHARE_CATEGORIES].sort().join() && shareG.categories.includes("UPLOADS") && !shareG.categories.includes("CLINICAL_NOTES") && shareG.sensitiveCategories.length === 0);
  const sg = await redeem(g.code);
  const vg = (await view(sg!.id)).history;
  report("CONDITIONS shows the diagnosis and the problem list", has(vg.conditions, `dx${tag}`) && has(vg.conditions, `pl${tag}`));
  report("…and the confirmed patient-provided condition (with UPLOADS)", has(vg.uploads?.entries, `qpd${tag}`));
  report("…but not the sensitive (psychiatric) diagnosis without its opt-in", !has(vg, `sdx${tag}`));
  report("VITALS shows the vitals", (vg.vitals ?? []).some((v) => v.sbp === 142 && v.dbp === 91));
  report("No clinical notes by default (section absent, text nowhere)", vg.clinicalNotes === undefined && !has(vg, `note${tag}`));
  report("Allergies are always there", has(vg.allergies, `qal${tag}`));
  report("The uploads list the MRI report, never the ID proof or the withdrawn upload", has(vg.uploads?.documents, `MRI right knee report ${tag}`) && !has(vg.uploads?.documents, `Aadhaar ${tag}`) && !has(vg.uploads?.documents, `Withdrawn scan ${tag}`));

  const dl = (ref: string, docId: string, by = doc) => personDocumentDownload({ kind: "SHARE", userId: by.userId, facilityId: PUNE, role: "DOCTOR", shareRef: ref }, docId);
  const before = Date.now();
  const got = await dl(sg!.id, mri);
  const token = decodeURIComponent(got.url.split("token=")[1] ?? "");
  const ttl = new Date(got.expiresAt).getTime() - before;
  report("A doctor with the share opens the uploaded MRI through a signed URL for exactly that file", !!got.url && verifyDownloadToken(token) === (await prisma.personDocument.findUniqueOrThrow({ where: { id: mri } })).storageRef);
  report("…valid for 5 minutes at most", ttl > 0 && ttl <= 300_000 + 2_000, `${Math.round(ttl / 1000)}s`);
  const dlLog = await prisma.personAccessLogEntry.findFirst({ where: { personId: Q.personId, kind: "RECORD_ACCESSED", actorUserId: doc.userId, detail: { path: ["surface"], equals: "DOCUMENT_DOWNLOAD" } } });
  report("…in the person's access log (DOCUMENT_DOWNLOAD, through the visit code, the share named)", (dlLog?.detail as { via?: string; shareId?: string } | null)?.via === "SHARE_CODE" && (dlLog?.detail as { shareId?: string }).shareId === shareG.id);
  report("…and audited", (await prisma.auditEvent.count({ where: { type: "person.document.accessedViaShare", userId: doc.userId, detail: { path: ["documentId"], equals: mri } } })) === 1);
  report("Another doctor holding the session id can't open it (404)", await notFound(dl(sg!.id, mri, other)));
  report("The ID proof can't be opened through a share (404)", await notFound(dl(sg!.id, idProof)));
  report("A withdrawn upload can't be opened (404)", await notFound(dl(sg!.id, withdrawn)));
  report("Another person's upload can't be opened through this share (404)", await notFound(dl(sg!.id, othersDoc)));
  report("An opening that is refused leaves no log entry or audit", (await prisma.auditEvent.count({ where: { type: "person.document.accessedViaShare", OR: [idProof, withdrawn, othersDoc].map((d) => ({ detail: { path: ["documentId"], equals: d } })) } })) === 0
    && (await prisma.personAccessLogEntry.count({ where: { personId: { in: [Q.personId, R.personId] }, OR: [idProof, withdrawn, othersDoc].map((d) => ({ detail: { path: ["documentId"], equals: d } })) } })) === 0);

  const h = await issueQ({ categories: ["CONDITIONS", "CLINICAL_NOTES", "LABS"], sensitiveCategories: ["MENTAL_HEALTH"], period: { from: "2026-01-01" } }, false);
  const sh = await redeem(h.code);
  const vh = (await view(sh!.id)).history;
  report("CLINICAL_NOTES ticked: the signed note is shown", has(vh.clinicalNotes, `note${tag}`));
  report("The MENTAL_HEALTH opt-in shows the psychiatric diagnosis", has(vh.conditions, `sdx${tag}`));
  report("UPLOADS unticked: no uploads section, no patient-provided condition, and no file opens (404)", vh.uploads === undefined && !has(vh, `qpd${tag}`) && await notFound(dl(sh!.id, mri)));
  report("The previous visit's share ended with it, so its URL can't be minted again (404)", await notFound(dl(sg!.id, mri)));
  const i = await issueQ({ categories: ["UPLOADS"], period: { from: "2026-01-01" } }, false);
  const si = await redeem(i.code);
  report("An upload outside the share's period can't be opened (404); one inside can", await notFound(dl(si!.id, oldUpload)) && !!(await dl(si!.id, mri)).url);

  // An approved request's doctor opens the upload through the request's share.
  const asked = await requestAccess(other.actor, { patientId: Q.pune, categories: ["UPLOADS", "CONDITIONS"], purpose: "CONSULTATION" });
  const approved = await decideRequest(Q.userId, asked.id, { decision: "APPROVE" });
  const viaReq = await dl(approved.shareId!, mri, other);
  const reqLog = await prisma.personAccessLogEntry.findFirst({ where: { personId: Q.personId, actorUserId: other.userId, detail: { path: ["surface"], equals: "DOCUMENT_DOWNLOAD" } } });
  report("An approved request's doctor opens the upload too, logged through the request", !!viaReq.url && (reqLog?.detail as { via?: string } | null)?.via === "ACCESS_REQUEST");
  report("…but the first doctor can't use the request's share (404)", await notFound(dl(approved.shareId!, mri, doc)));

  await done();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
