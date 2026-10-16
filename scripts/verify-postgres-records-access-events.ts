/**
 * Workflow spine §9 step 7: documents, notes, patient access and consent
 * events. (Family acceptance/revocation, profile updates and account linking
 * are asserted in the D11 and self-registration gates, which drive them.)
 *
 *   1. PatientDocumentUploaded on a portal upload → the task-generator opens one
 *      DOCUMENT_REVIEW task (redelivery opens no second one).
 *   2. DocumentGenerated (document type, draft flag, never content).
 *   3. ClinicalNoteSigned on sign and on amend (naming the note replaced),
 *      never the content.
 *   4. Consent: ConsentRequestStatusChanged (requested, declined) and
 *      ConsentExpired per lapsed consent, all SENSITIVE.
 *   5. Access codes: PatientAccessSessionStatusChanged for issue, redeem,
 *      extend, end, and the expiry of a stale code when a new one is issued.
 *   6. The runner expires an ACTIVE delegation past its date with
 *      FamilyAccessRevoked (EXPIRED); a lapsed invitation emits nothing.
 *   7. PatientDemographicsUpdated for an MRN added by staff (type, no value).
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-records-access-events.ts
 */
import { PDFDocument } from "pdf-lib";
import { prisma } from "../src/lib/db";
import { uploadPatientDocument } from "../src/lib/patient/experience/documents";
import { generateAndStoreDocument } from "../src/lib/documents/service";
import { signNote, amendNote } from "../src/lib/hospital/clinicalNote";
import { requestConsent, closeConsentRequest, grantConsent, expireLapsedConsents } from "../src/lib/consent/lifecycle";
import { issueAccessCode, redeemAccessCode, extendAccessSession, endAccessSession } from "../src/lib/patient/accessSession";
import { sweepDelegationExpiry } from "../src/lib/patient/experience/delegationSweep";
import { addPatientIdentifier } from "../src/lib/patient/identifiers";
import { openEncounter } from "../src/lib/hospital/encounter";
import { getEventContract } from "../src/lib/events/catalogue";
import { runTick } from "../src/lib/runner/tick";
import type { PatientAccessScope } from "../src/lib/patient/context";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const ALL = ["PERSONAL", "APPOINTMENTS", "QUEUE", "RECORDS", "REPORTS", "PRESCRIPTIONS", "MEDICATIONS", "BILLING", "INSURANCE", "CONSENT"] as const;
const drain = async () => { for (let i = 0; i < 5; i++) if (!(await runTick({ budgetMs: 20_000 })).moreWork) break; };

async function main() {
  const run = Date.now().toString(36);
  const facilityId = "fac-amc-pune";
  const doctor = await prisma.user.findFirstOrThrow({ where: { email: "doctor1@amc-demo.aarogya" }, include: { hospitalStaffProfile: true } });
  const staffId = doctor.hospitalStaffProfile!.id;
  const user = await prisma.user.create({ data: { email: `records-${run}@verify.aarogya`, passwordHash: "x", role: "PATIENT", displayName: "Records patient" } });
  const patient = await prisma.patient.create({ data: { uhid: `REC-${run}`, facilityId, fullName: `Records ${run}`, sex: "F", userId: user.id } });
  const scope: PatientAccessScope = { patientId: patient.id, patientIds: [patient.id], facilityId, isSelf: true, allowedClasses: new Set(ALL) };
  const events = (type: string, aggregateId: string) => prisma.domainEventOutbox.findMany({ where: { eventType: type, aggregateId }, orderBy: { seq: "asc" } });
  const payloads = async (type: string, aggregateId: string) => (await events(type, aggregateId)).map((e) => e.payload as Record<string, unknown>);

  // 1. Portal upload.
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 100]).drawText(`report ${run}`, { x: 10, y: 50, size: 8 });
  const up = await uploadPatientDocument(scope, user.id, { bytes: Buffer.from(await pdf.save()), contentType: "application/pdf", originalName: "r.pdf", title: `Outside report ${run}`, type: "REPORT" });
  const uploaded = await payloads("PatientDocumentUploaded", up.id);
  report("A portal upload emits PatientDocumentUploaded (type, uploader; no title)", uploaded.length === 1 && uploaded[0].documentType === "REPORT" && uploaded[0].uploadedBy === "PATIENT" && !JSON.stringify(uploaded).includes("Outside"));
  await drain();
  const reviewKey = { facilityId_idempotencyKey: { facilityId, idempotencyKey: `DOCUMENT_REVIEW:${up.id}` } };
  report("task-generator opens one DOCUMENT_REVIEW task for the care team", (await prisma.task.findUnique({ where: reviewKey }))?.status === "OPEN");

  // 2. Generated document.
  const gen = await generateAndStoreDocument(
    { type: "prescription", patient: { name: patient.fullName, uhid: patient.uhid ?? undefined }, diagnosis: "step 7", items: [{ drug: "Drug", dose: "1", frequency: "OD", duration: "1 day" }] },
    { facilityId, letterhead: { facilityName: "Aarogya Medical Centre", authorName: "Dr Verify", authorRegistration: "MMC-0000" }, issuedByUserId: doctor.id, patientId: patient.id },
  );
  const generated = await payloads("DocumentGenerated", gen.clinicalDocumentId);
  report("generateAndStoreDocument emits DocumentGenerated (type, draft flag, both ids)", generated.length === 1 && generated[0].documentType === "prescription" && generated[0].isDraft === false && generated[0].generatedDocumentId === gen.id);

  // 3. Notes.
  const enc = await openEncounter({ facilityId, patientId: patient.id, type: "OPD", chiefComplaint: "Notes", byUserId: doctor.id });
  const draft = await prisma.clinicalNote.create({ data: { encounterId: enc.id, authorStaffId: staffId, authorRole: "DOCTOR", type: "SOAP", content: { s: `secret ${run}` }, status: "DRAFT" } });
  await signNote({ noteId: draft.id, encounterId: enc.id, byUserId: doctor.id });
  const amended = await amendNote({ supersedesId: draft.id, encounterId: enc.id, authorStaffId: staffId, authorRole: "DOCTOR", type: "SOAP", content: { s: `fixed ${run}` }, amendmentReason: "typo", byUserId: doctor.id });
  const signed = await payloads("ClinicalNoteSigned", draft.id);
  const amend = await payloads("ClinicalNoteSigned", amended.id);
  report("signNote → ClinicalNoteSigned (type SOAP, no content), correlated by the encounter",
    signed.length === 1 && signed[0].entryType === "SOAP" && !JSON.stringify(signed).includes("secret") && (await events("ClinicalNoteSigned", draft.id))[0].correlationId === enc.id);
  report("amendNote → ClinicalNoteSigned naming the note it supersedes", amend.length === 1 && amend[0].supersedesEntryId === draft.id);

  // 4. Consent.
  const consentInput = { facilityId, patientId: patient.id, purpose: "TREATMENT", scopes: ["LAB"], recipientType: "FACILITY", recipientIdentifier: `HFR-${run}`, byUserId: doctor.id };
  const c1 = await requestConsent(consentInput);
  await closeConsentRequest({ facilityId, consentId: c1.id, to: "DECLINED", byUserId: doctor.id });
  const c1Events = await events("ConsentRequestStatusChanged", c1.id);
  report("Consent requested then declined → ConsentRequestStatusChanged ×2, SENSITIVE",
    c1Events.map((e) => `${(e.payload as { from: string | null }).from}>${(e.payload as { to: string }).to}`).join() === "null>REQUESTED,REQUESTED>DECLINED"
      && getEventContract("ConsentRequestStatusChanged", 1)?.sensitivity === "SENSITIVE");
  const c2 = await requestConsent({ ...consentInput, expiresAt: new Date(Date.now() + 3_600_000) });
  await grantConsent({ facilityId, consentId: c2.id, grantedBy: "STAFF_RECORDED", byUserId: doctor.id });
  await prisma.interopConsent.update({ where: { id: c2.id }, data: { expiresAt: new Date(Date.now() - 1000) } }); // simulate the lapse
  const swept = await expireLapsedConsents(facilityId);
  const expired = await payloads("ConsentExpired", c2.id);
  report("expireLapsedConsents → ConsentExpired once per lapsed consent", swept.expired >= 1 && expired.length === 1 && expired[0].patientId === patient.id);
  report("…and a second sweep expires nothing more for it", (await expireLapsedConsents(facilityId)) && (await events("ConsentExpired", c2.id)).length === 1);

  // 5. Access codes.
  const first = await issueAccessCode(patient.id, user.id, "visit");
  const second = await issueAccessCode(patient.id, user.id, "visit");
  const redeemed = await redeemAccessCode({ code: second.code, doctorUserId: doctor.id, doctorStaffId: staffId, facilityId });
  await extendAccessSession(second.session.id);
  await endAccessSession(second.session.id, "DOCTOR", doctor.id);
  const s1 = (await payloads("PatientAccessSessionStatusChanged", first.session.id)).map((p) => `${p.from}>${p.to}`).join();
  const s2 = (await payloads("PatientAccessSessionStatusChanged", second.session.id)).map((p) => `${p.from}>${p.to}${p.extended ? "+" : ""}`).join();
  report("A stale code expires when a new one is issued", s1 === "null>PENDING,PENDING>EXPIRED", s1);
  report("issue, redeem, extend, end → PatientAccessSessionStatusChanged in order", !!redeemed && s2 === "null>PENDING,PENDING>ACTIVE,ACTIVE>ACTIVE+,ACTIVE>ENDED", s2);

  // 6. Delegation expiry in the runner.
  const delegate = await prisma.user.create({ data: { email: `delegate-${run}@verify.aarogya`, passwordHash: "x", role: "PATIENT", displayName: "Delegate" } });
  const active = await prisma.patientDelegation.create({ data: { patientId: patient.id, delegateUserId: delegate.id, relationship: "OTHER", status: "ACTIVE", expiresAt: new Date(Date.now() - 1000), scopes: { create: [{ scope: "RECORDS" }] } } });
  const invited = await prisma.patientDelegation.create({ data: { patientId: patient.id, relationship: "OTHER", status: "INVITED", expiresAt: new Date(Date.now() - 1000), scopes: { create: [{ scope: "RECORDS" }] } } });
  const swept2 = await sweepDelegationExpiry({});
  const revoked = await payloads("FamilyAccessRevoked", active.id);
  report("The runner expires an ACTIVE delegation past its date with FamilyAccessRevoked (EXPIRED)",
    swept2.expired >= 2 && (await prisma.patientDelegation.findUniqueOrThrow({ where: { id: active.id } })).status === "EXPIRED" && revoked.length === 1 && revoked[0].reason === "EXPIRED");
  report("…a lapsed invitation becomes EXPIRED with no event (it gave no access)",
    (await prisma.patientDelegation.findUniqueOrThrow({ where: { id: invited.id } })).status === "EXPIRED" && (await events("FamilyAccessRevoked", invited.id)).length === 0);

  // 7. Identifier.
  await addPatientIdentifier({ facilityId, patientId: patient.id, type: "MRN", value: `MRN-${run}`, byUserId: doctor.id });
  const ident = (await payloads("PatientDemographicsUpdated", patient.id)).filter((p) => p.changeKind === "IDENTIFIER_ADDED");
  report("An MRN added by staff → PatientDemographicsUpdated (type, never the value)", ident.length === 1 && ident[0].identifierType === "MRN" && !JSON.stringify(ident).includes(`MRN-${run}`));

  // Redelivery creates no second review task.
  await drain();
  const ids = (await prisma.domainEventOutbox.findMany({ where: { eventType: "PatientDocumentUploaded", aggregateId: up.id }, select: { eventId: true } })).map((e) => e.eventId);
  await prisma.domainEventDelivery.updateMany({ where: { eventId: { in: ids } }, data: { status: "PENDING" } });
  await prisma.domainEventOutbox.updateMany({ where: { eventId: { in: ids } }, data: { status: "PENDING", processedAt: null } });
  await drain();
  report("Redelivering the upload opens no second review task", (await prisma.task.count({ where: { idempotencyKey: `DOCUMENT_REVIEW:${up.id}` } })) === 1);

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
