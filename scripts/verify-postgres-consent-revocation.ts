/**
 * D2: one consent model, one consent service, and revocation is honoured by
 * every consumer.
 *
 * For each kind of consent: prove each consumer allows access while the
 * consent is live, revoke it, and prove each consumer refuses.
 *   A. Patient sharing consent (portal createSharingRequest): HIE exchange
 *      guard, FHIR export, authorization engine's sharing policy.
 *   B. Staff-recorded treatment consent (the old Consent model, now an
 *      InteropConsent with the facility as recipient): consent evaluation.
 *   C. Family delegation: portal reads of the delegated record and the AI
 *      assistant's context.
 * Also checks that the Consent table is gone (one model).
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-consent-revocation.ts
 */
import { prisma } from "../src/lib/db";
import { NotFoundError } from "../src/lib/auth/rbac";
import {
  assertExchangeAuthorized, canSharePatientData, evaluateConsent, requestConsent, grantConsent, revokeConsent,
} from "../src/lib/consent";
import { exportPatientToFhir } from "../src/lib/hospital/interoperability/fhir/export";
import { createSharingRequest, revokePatientConsent } from "../src/lib/patient/experience/consent";
import { revokeDelegation } from "../src/lib/patient/experience/family";
import { resolveReadScope, type PatientAccessScope, type PatientContext } from "../src/lib/patient/context";
import { patientAssistantContext } from "../src/lib/ai/assistantContext";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const allows = (p: Promise<unknown>) => p.then(() => true, () => false);
const ALL = ["PERSONAL", "APPOINTMENTS", "QUEUE", "RECORDS", "REPORTS", "PRESCRIPTIONS", "MEDICATIONS", "BILLING", "INSURANCE", "CONSENT"] as const;

async function main() {
  const run = Date.now().toString(36);
  const tables = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'Consent'`;
  report("There is one consent model (the Consent table is gone)", Number(tables[0].n) === 0);

  const facilityId = "fac-amc-pune";
  const owner = await prisma.user.create({ data: { email: `consent-owner-${run}@verify.aarogya`, passwordHash: "x", role: "PATIENT", displayName: "Consent owner" } });
  const patient = await prisma.patient.create({ data: { uhid: `CONSENT-${run}`, facilityId, fullName: `Consent Patient ${run}`, sex: "F", userId: owner.id } });
  const self: PatientAccessScope = { patientId: patient.id, patientIds: [patient.id], facilityId, isSelf: true, allowedClasses: new Set(ALL) };
  const staffUser = await prisma.user.findFirstOrThrow({ where: { email: "admin@amc-demo.aarogya" } });

  // A. Patient sharing consent.
  const recipient = `partner-${run}`;
  const sharing = await createSharingRequest(self, owner.id, { purpose: "REFERRAL", scopes: ["ALL_CLINICAL"], recipientType: "FACILITY", recipientIdentifier: recipient, recipientName: "Partner" });
  const exchangeReq = { facilityId, patientId: patient.id, purpose: "REFERRAL", scopes: ["LAB"], consentId: sharing.id, recipientIdentifier: recipient };
  const exportReq = { ...exchangeReq, byUserId: staffUser.id };
  const shareReq = { facilityId, patientId: patient.id, purpose: "REFERRAL", scopes: ["LAB"], recipientIdentifier: recipient };
  report("Live sharing consent: the exchange guard allows", await allows(assertExchangeAuthorized(exchangeReq)));
  report("Live sharing consent: FHIR export allows", await allows(exportPatientToFhir(exportReq)));
  report("Live sharing consent: the sharing policy allows", (await canSharePatientData(shareReq)).allowed);

  await revokePatientConsent(self, owner.id, sharing.id, "verify gate");
  report("Revoked: the exchange guard refuses", !(await allows(assertExchangeAuthorized(exchangeReq))));
  const exportAfter = await exportPatientToFhir(exportReq).then(() => "exported", (e) => (e as Error).message);
  report("Revoked: FHIR export refuses", /revoked/i.test(exportAfter), exportAfter);
  const shareAfter = await canSharePatientData(shareReq);
  report("Revoked: the sharing policy refuses", !shareAfter.allowed, shareAfter.reason ?? "");

  // B. Staff-recorded treatment consent (the old Consent model).
  const recorded = await requestConsent({
    facilityId, patientId: patient.id, purpose: "TREATMENT", scopes: ["ALL_CLINICAL"], recipientType: "FACILITY",
    recipientIdentifier: facilityId, description: "Chemotherapy course", byUserId: staffUser.id,
  });
  await grantConsent({ facilityId, consentId: recorded.id, grantedBy: "STAFF_RECORDED", byUserId: staffUser.id });
  const treatment = { facilityId, patientId: patient.id, purpose: "TREATMENT", consentId: recorded.id };
  report("Live treatment consent: evaluation allows", (await evaluateConsent(treatment)).usable);
  await revokeConsent({ facilityId, consentId: recorded.id, reason: "verify gate", byUserId: staffUser.id });
  const evalAfter = await evaluateConsent(treatment);
  report("Revoked: evaluation refuses", !evalAfter.usable, evalAfter.reason ?? "");

  // C. Family delegation.
  const delegateUser = await prisma.user.create({ data: { email: `consent-delegate-${run}@verify.aarogya`, passwordHash: "x", role: "PATIENT", displayName: "Delegate" } });
  const delegation = await prisma.patientDelegation.create({
    data: { patientId: patient.id, delegateUserId: delegateUser.id, relationship: "CAREGIVER", status: "ACTIVE", acceptedAt: new Date(), createdByUserId: owner.id, scopes: { create: [{ scope: "RECORDS" }, { scope: "APPOINTMENTS" }] } },
  });
  const delegateCtx: PatientContext = { session: { userId: delegateUser.id, role: "PATIENT" } as PatientContext["session"], userId: delegateUser.id, selfPatientId: null };
  const live = await resolveReadScope(delegateCtx, patient.id).catch(() => null);
  report("Live delegation: the delegate can read the record", live !== null && live.allowedClasses.has("RECORDS"));
  report("Live delegation: the AI assistant gets context", live !== null && (await patientAssistantContext(live)).includes("delegated access"));

  await revokeDelegation(self, owner.id, delegation.id, "verify gate");
  const after = await resolveReadScope(delegateCtx, patient.id).then(() => "read", (e) => (e instanceof NotFoundError ? "404" : String(e)));
  report("Revoked: the delegate's portal reads are refused (404)", after === "404", after);
  const aiAfter = await resolveReadScope(delegateCtx, patient.id).then((s) => patientAssistantContext(s)).then(() => "context built", () => "refused");
  report("Revoked: the AI assistant gets no context", aiAfter === "refused");

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
