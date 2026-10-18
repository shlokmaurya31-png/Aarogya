process.env.EMAIL_PROVIDER = "outbox";

/**
 * Phase 0, part 1 (e): the person leak gate. Zero tolerance.
 *
 * Person B's own data carries a unique canary: an upload's title, a
 * patient-provided entry's value (Week 4a), a contact
 * and the access log. Then every staff-side surface that can show a
 * patient's documents (the documents list's filter, timeline, summary, the
 * clinician AI context) and every other account is asked, in each state:
 *
 *   B hasn't chosen to share uploads              → staff see nothing
 *   B shares, but no care relationship            → nothing
 *   B shares, an open encounter at Pune           → Pune staff see the upload
 *                                                    (positive control: the
 *                                                    check can fail)
 *   B shares; a Noida record but no care there    → nothing for Noida staff
 *   B shares; Noida treating someone else          → nothing of B's
 *   B shares; Noida treats B                       → Noida sees it (uploads are
 *                                                    the person's, not Pune's)
 *   B declines again                              → nothing
 *   B unlinks Pune                                → nothing
 *   Person A's own login, at any point            → nothing of B's
 *   staff asking for B's profile/contacts/log     → nothing, ever
 *
 * Part 2 adds: a facility merge carries visibility to the target record and
 * an unmerge takes it back; after a Person merge the merged-away login sees
 * nothing and different sharing choices lapse; a closed account's uploads
 * vanish for staff at once, and after the purge the bytes are gone too.
 *
 * The canary never appearing where it shouldn't is the pass condition; it
 * appearing for B themselves and for treating staff after sharing proves the
 * check sees it when present.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-person-leaks.ts
 */
import { prisma } from "../src/lib/db";
import { listOwnRecords, staffPatientProvidedRecords } from "../src/lib/documents/merge";
import { facilityConflicts, listOwnConflicts } from "../src/lib/documents/conflicts";
import { registerPatientAccount, connectFacilityRecord } from "../src/lib/patient/selfRegistration";
import { uploadPatientDocument } from "../src/lib/patient/experience/documents";
import { listReports } from "../src/lib/patient/experience/reports";
import { buildPatientTimeline } from "../src/lib/patient/timeline";
import { buildPatientSummary } from "../src/lib/patient/summary";
import { clinicianAssistantContext } from "../src/lib/ai/assistantContext";
import { staffDocumentVisibility, personAccess } from "../src/lib/person/access";
import { staffPersonDocuments, personDocumentDownload } from "../src/lib/person/documents";
import { personOverview } from "../src/lib/person/overview";
import { decidePersonConsent } from "../src/lib/person/consent";
import { unlinkByPerson } from "../src/lib/person/linking";
import type { PatientAccessScope } from "../src/lib/patient/context";
import { readFile } from "node:fs/promises";
import { EMAIL_OUTBOX_FILE } from "../src/lib/email/send";
import { hashPassword } from "../src/lib/auth/password";
import { mergePatients, unmergePatients } from "../src/lib/patient/merge";
import { startPersonMerge, confirmPersonMerge } from "../src/lib/person/merge";
import { closePersonAccount, purgeClosedPersons } from "../src/lib/person/closure";
import { uploadPersonDocument } from "../src/lib/person/documents";
import { selfPatientIds } from "../src/lib/person/self";
import { getStorageAdapter } from "../src/lib/storage";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const run = Date.now().toString(36);
const CANARY = `LEAKCANARY${run}`;
const PUNE = "fac-amc-pune";
const NOIDA = "fac-amc-noida";
const ALL = ["PERSONAL", "APPOINTMENTS", "QUEUE", "RECORDS", "REPORTS", "PRESCRIPTIONS", "MEDICATIONS", "BILLING", "INSURANCE", "CONSENT"] as const;

async function main() {
  const a = await registerPatientAccount({ fullName: `Leak A ${run}`, email: `leak-a-${run}@verify.aarogya`, passwordHash: "x", sex: "M", dob: new Date("1970-01-02") });
  const b = await registerPatientAccount({ fullName: `Leak B ${run}`, email: `leak-b-${run}@verify.aarogya`, passwordHash: "x", sex: "F", dob: new Date("1975-03-04") });
  if (a.status !== "LINKED_NEW" || b.status !== "LINKED_NEW") throw new Error("fixtures: both sign-ups should create their records");
  const pb = b.patientId;
  const personB = (await prisma.personAccount.findUniqueOrThrow({ where: { userId: b.userId } })).personId;
  const personA = (await prisma.personAccount.findUniqueOrThrow({ where: { userId: a.userId } })).personId;
  // Canaries in B's person-level data.
  await prisma.personContact.create({ data: { personId: personB, kind: "EMAIL", value: `${CANARY.toLowerCase()}@contact.example` } });
  await prisma.personAccessLogEntry.create({ data: { personId: personB, kind: "RECORD_ACCESSED", detail: { note: CANARY } } });
  const scopeB: PatientAccessScope = { patientId: pb, patientIds: [pb], facilityId: PUNE, isSelf: true, allowedClasses: new Set(ALL) };
  const up = await uploadPatientDocument(scopeB, b.userId, { bytes: Buffer.from("%PDF-1.4\n%leak\n"), contentType: "application/pdf", originalName: "leak.pdf", title: `Report ${CANARY}`, type: "REPORT" })
    .catch(async () => {
      // Fall back to a valid PDF if the content check needs one.
      const { PDFDocument } = await import("pdf-lib");
      const pdf = await PDFDocument.create(); pdf.addPage([100, 100]);
      return uploadPatientDocument(scopeB, b.userId, { bytes: Buffer.from(await pdf.save()), contentType: "application/pdf", originalName: "leak.pdf", title: `Report ${CANARY}`, type: "REPORT" });
    });
  report("Fixture: B's upload is B's own PersonDocument", (await prisma.personDocument.findUniqueOrThrow({ where: { id: up.id } })).personId === personB);
  // Week 4a: a confirmed patient-provided entry of B's, with the canary in its value.
  const canaryRecord = await prisma.patientProvidedRecord.create({ data: { personId: personB, kind: "LAB_RESULT", value: { analyte: `Canary ${CANARY}`, value: "1", unit: "mg/dL" }, factId: `leak-fact-${run}`, documentId: up.id, pageNo: 1 } });
  // …and a conflict about it at B's facility record (its display carries the entry's value).
  await prisma.recordConflict.create({ data: { personId: personB, facilityId: PUNE, patientId: pb, kind: "LAB_RESULT", patientProvidedRecordId: canaryRecord.id, verifiedSourceType: "LabResult", verifiedSourceId: `leak-result-${run}` } });

  // Every staff-side surface, as text.
  const staffViews = async (facilityId: string, patientId: string) => {
    const docs = [
      ...(await prisma.clinicalDocument.findMany({ where: { AND: [{ patientId }, await staffDocumentVisibility(facilityId, [patientId])] } })),
      ...(await staffPersonDocuments(facilityId, [patientId])),
    ];
    const [timeline, summary] = await Promise.all([buildPatientTimeline(patientId, { kind: "STAFF", facilityId }), buildPatientSummary(patientId, { kind: "STAFF", facilityId })]);
    const ai = await clinicianAssistantContext(patientId, facilityId);
    const provided = await staffPatientProvidedRecords(facilityId, [patientId]);
    const conflicts = await facilityConflicts(facilityId, [patientId]);
    return JSON.stringify({ docs, timeline, summary, ai, provided, conflicts });
  };
  const sees = async (facilityId: string, patientId: string) => (await staffViews(facilityId, patientId)).includes(CANARY);
  const aSees = async () => {
    const own = await personOverview(a.userId);
    const scopeA: PatientAccessScope = { patientId: a.patientId, patientIds: [a.patientId], facilityId: PUNE, isSelf: true, allowedClasses: new Set(ALL) };
    return JSON.stringify({ own, reports: await listReports(scopeA), access: await personAccess({ kind: "OWNER", userId: a.userId }, personB, "UPLOADS"), provided: await listOwnRecords(a.userId), conflicts: await listOwnConflicts(a.userId) }).includes(CANARY)
      || (await personAccess({ kind: "OWNER", userId: a.userId }, personB, "PROFILE")) !== null;
  };
  const staffProfile = async (facilityId: string) => (await personAccess({ kind: "STAFF", userId: "staff", facilityId }, personB, "PROFILE")) !== null;

  // Positive controls: B sees their own canaries.
  const bOwn = JSON.stringify({ o: await personOverview(b.userId), r: await listReports(scopeB), p: await listOwnRecords(b.userId) });
  report("Control: B sees their own upload", bOwn.includes(CANARY));

  report("B hasn't chosen: Pune staff see nothing of the upload", !(await sees(PUNE, pb)));
  report("…and A sees nothing of B's", !(await aSees()));
  report("…and staff never get B's profile, contacts or access log", !(await staffProfile(PUNE)) && !(await staffProfile(NOIDA)));

  await decidePersonConsent({ userId: b.userId, purpose: "SHARE_UPLOADS_WITH_TREATING", decision: "GRANTED" });
  report("B shares, but no care relationship: Pune staff still see nothing", !(await sees(PUNE, pb)));

  await prisma.encounter.create({ data: { patientId: pb, facilityId: PUNE, type: "OPD", status: "IN_CONSULTATION", chiefComplaint: "leak gate" } });
  report("Control: B shares and has an open encounter at Pune — Pune staff see the upload", await sees(PUNE, pb));
  report("…but never B's profile, contacts or access log", !(await staffProfile(PUNE)) && !(await staffViews(PUNE, pb)).includes(`${CANARY.toLowerCase()}@contact`));
  report("…and A still sees nothing of B's", !(await aSees()));

  // Uploads are the person's (not Pune's): a hospital that treats B sees them
  // once B shares — and only while it treats B, only through B's own record.
  const noida = await connectFacilityRecord(b.userId, { facilityId: NOIDA, fullName: `Leak B Noida ${run}`, sex: "F" });
  const pbn = noida.status === "LINKED_NEW" ? noida.patientId : "";
  report("B shares and has a Noida record but no care there: Noida staff see nothing", Boolean(pbn) && !(await sees(NOIDA, pbn)));
  report("…and can't download it through that record (signed URL refused)",
    await personDocumentDownload({ kind: "STAFF", userId: "noida-staff", facilityId: NOIDA, patientId: pbn }, up.id).then(() => false, () => true));
  const unrelated = await prisma.patient.create({ data: { uhid: `LEAKN-${run}`, facilityId: NOIDA, fullName: `Leak unrelated ${run}`, sex: "M" } });
  await prisma.encounter.create({ data: { patientId: unrelated.id, facilityId: NOIDA, type: "OPD", status: "IN_CONSULTATION", chiefComplaint: "leak gate" } });
  report("Noida staff treating someone else see nothing of B's", !(await sees(NOIDA, unrelated.id))
    && await personDocumentDownload({ kind: "STAFF", userId: "noida-staff", facilityId: NOIDA, patientId: unrelated.id }, up.id).then(() => false, () => true));
  await prisma.encounter.create({ data: { patientId: pbn, facilityId: NOIDA, type: "OPD", status: "IN_CONSULTATION", chiefComplaint: "leak gate" } });
  report("Control: once Noida treats B (B shares), Noida staff see B's upload through B's record", await sees(NOIDA, pbn));

  await decidePersonConsent({ userId: b.userId, purpose: "SHARE_UPLOADS_WITH_TREATING", decision: "DECLINED" });
  report("B declines again: Pune staff see nothing", !(await sees(PUNE, pb)));

  await decidePersonConsent({ userId: b.userId, purpose: "SHARE_UPLOADS_WITH_TREATING", decision: "GRANTED" });
  report("Control: sharing again restores it for Pune staff", await sees(PUNE, pb));
  const puneLink = await prisma.personPatientLink.findFirstOrThrow({ where: { personId: personB, patientId: pb, status: "ACTIVE" } });
  await unlinkByPerson(b.userId, puneLink.id);
  report("B unlinks Pune: Pune staff see nothing, even while sharing", !(await sees(PUNE, pb)));
  report("…A never saw anything of B's", !(await aSees()) && personA !== personB);

  // ── Part 2: merges and closure ──
  const admin = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { user: { role: "HOSPITAL_ADMIN" } }, select: { id: true, userId: true } });
  const pdfBytes = async () => { const { PDFDocument } = await import("pdf-lib"); const d = await PDFDocument.create(); d.addPage([100, 100]); return Buffer.from(await d.save()); };
  const fresh = async (tag: string) => {
    const r = await registerPatientAccount({ fullName: `Leak ${tag} ${run}`, email: `leak-${tag}-${run}@verify.aarogya`, passwordHash: await hashPassword(`Leak@${run}`), sex: "F", dob: new Date("1966-06-06") });
    if (r.status !== "LINKED_NEW") throw new Error(`fixture ${tag}`);
    await prisma.encounter.create({ data: { patientId: r.patientId, facilityId: PUNE, type: "OPD", status: "IN_CONSULTATION", chiefComplaint: "leak part 2" } });
    await decidePersonConsent({ userId: r.userId, purpose: "SHARE_UPLOADS_WITH_TREATING", decision: "GRANTED" });
    const doc = await uploadPersonDocument(r.userId, { bytes: await pdfBytes(), contentType: "application/pdf", originalName: `${tag}.pdf`, title: `Report ${CANARY}-${tag}`, type: "REPORT" });
    return { ...r, doc };
  };
  const seesDoc = async (patientId: string, docId: string) => (await staffPersonDocuments(PUNE, [patientId])).some((d) => d.id === docId);

  // Facility merge: visibility follows the carried link; unmerge takes it back.
  const g = await fresh("g");
  const gTarget = await prisma.patient.create({ data: { uhid: `LEAKG-${run}`, facilityId: PUNE, fullName: `Leak G target ${run}`, sex: "F" } });
  await prisma.encounter.create({ data: { patientId: gTarget.id, facilityId: PUNE, type: "OPD", status: "IN_CONSULTATION", chiefComplaint: "leak part 2" } });
  report("Before a facility merge, the target record shows nothing of the person's", !(await seesDoc(gTarget.id, g.doc.id)));
  await mergePatients({ sourcePatientId: g.patientId, targetPatientId: gTarget.id, actorStaffId: admin.id, actorUserId: admin.userId, reason: "duplicate" });
  report("After it, staff see the person's upload through the surviving record", await seesDoc(gTarget.id, g.doc.id));
  await unmergePatients({ patientId: g.patientId, actorStaffId: admin.id, actorUserId: admin.userId, reason: "wrong" });
  report("After the unmerge, the other record shows nothing of the person's again", !(await seesDoc(gTarget.id, g.doc.id)) && await seesDoc(g.patientId, g.doc.id));

  // Person merge: the merged-away login sees nothing; different choices lapse.
  const d = await fresh("d"); const e = await fresh("e");
  await decidePersonConsent({ userId: e.userId, purpose: "SHARE_UPLOADS_WITH_TREATING", decision: "DECLINED" });
  const req = await startPersonMerge(d.userId, { otherEmail: `leak-e-${run}@verify.aarogya`, otherPassword: `Leak@${run}` });
  const code = async (to: string) => {
    for (const l of (await readFile(EMAIL_OUTBOX_FILE, "utf8")).trim().split("\n").reverse()) { const m = JSON.parse(l) as { to: string; text: string }; if (m.to === to) return /\b(\d{6})\b/.exec(m.text)![1]; }
    return "";
  };
  await confirmPersonMerge(d.userId, req.requestId, { thisAccountCode: await code(`leak-d-${run}@verify.aarogya`), otherAccountCode: await code(`leak-e-${run}@verify.aarogya`) });
  report("After a Person merge, the merged-away login holds no record and sees nothing", (await selfPatientIds(e.userId)).length === 0
    && await personDocumentDownload({ kind: "OWNER", userId: e.userId }, e.doc.id).then(() => false, () => true));
  report("…the survivor owns both uploads", await personDocumentDownload({ kind: "OWNER", userId: d.userId }, e.doc.id).then(() => true, () => false));
  report("…and because the two sharing choices differed, staff see neither until the person chooses again",
    !(await seesDoc(d.patientId, d.doc.id)) && !(await seesDoc(e.patientId, e.doc.id)));

  // Closure: gone for staff at once; after the purge, the bytes too.
  const f = await fresh("f");
  report("Control: staff see the person's upload before closure", await seesDoc(f.patientId, f.doc.id));
  await closePersonAccount(f.userId, "CLOSE");
  const staffDl = () => personDocumentDownload({ kind: "STAFF", userId: admin.userId, facilityId: PUNE, patientId: f.patientId }, f.doc.id).then(() => false, () => true);
  report("A closed account's uploads are gone for staff at once (list and signed URL)", !(await seesDoc(f.patientId, f.doc.id)) && await staffDl());
  report("…and its own login sees nothing either", (await selfPatientIds(f.userId)).length === 0);
  const fPerson = (await prisma.personAccount.findUniqueOrThrow({ where: { userId: f.userId } })).personId;
  await prisma.person.update({ where: { id: fPerson }, data: { purgeAfter: new Date(Date.now() - 1000) } });
  await purgeClosedPersons({});
  report("After the purge, the upload's row and bytes are gone", (await prisma.personDocument.count({ where: { id: f.doc.id } })) === 0 && await getStorageAdapter().get(f.doc.storageRef).then(() => false, () => true));
  report("…and the canary appears in no staff view of the record", !(await staffViews(PUNE, f.patientId)).includes(`${CANARY}-f`));

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
