/**
 * D1: PatientIdentifier holds only Aarogya-issued identifiers (UHID, MRN);
 * every externally issued identifier is an ExternalIdentifier.
 *
 *   1. The database refuses an external identifier type in PatientIdentifier.
 *   2. Adding identifiers routes them: MRN to PatientIdentifier; ABHA number,
 *      ABHA address and insurer member IDs to ExternalIdentifier, unverified.
 *   3. An insurer member ID needs its insurer; an ABHA already held by another
 *      patient is refused.
 *   4. The patient API's reader returns both, labelled; search finds the
 *      patient by ABHA.
 *   5. The FHIR export carries the external identifiers.
 * (The NHCX claim bundle is checked in verify-postgres-nhcx; the HTTP patient
 * API in verify-postgres-one-patient.)
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-patient-identifiers.ts
 */
import { prisma } from "../src/lib/db";
import {
  addPatientIdentifier, listPatientIdentifiers, patientIdsByExternalIdentifier, externalSystemFor,
} from "../src/lib/patient/identifiers";
import { patientSearchWhere } from "../src/lib/hospital/patientSearch";
import { IDENTIFIER_SYSTEMS } from "../src/lib/hospital/interoperability/shared";
import { exportPatientToFhir } from "../src/lib/hospital/interoperability/fhir/export";
import { createSharingRequest } from "../src/lib/patient/experience/consent";
import type { PatientAccessScope } from "../src/lib/patient/context";
import { linkAccountForGate } from "./lib/personFixture";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const refused = (p: Promise<unknown>) => p.then(() => false, () => true);
const ALL = ["PERSONAL", "APPOINTMENTS", "QUEUE", "RECORDS", "REPORTS", "PRESCRIPTIONS", "MEDICATIONS", "BILLING", "INSURANCE", "CONSENT"] as const;

async function main() {
  const run = Date.now().toString(36);
  const facilityId = "fac-amc-pune";
  const staff = await prisma.user.findFirstOrThrow({ where: { email: "admin@amc-demo.aarogya" } });
  const owner = await prisma.user.create({ data: { email: `ids-${run}@verify.aarogya`, passwordHash: "x", role: "PATIENT", displayName: "Ids" } });
  const patient = await prisma.patient.create({ data: { uhid: `IDS-${run}`, facilityId, fullName: `Identifier Patient ${run}`, sex: "M" } });
  await linkAccountForGate(prisma, owner.id, patient.id);
  const other = await prisma.patient.create({ data: { uhid: `IDS2-${run}`, facilityId, fullName: `Identifier Other ${run}`, sex: "F" } });

  // 1. The CHECK constraint.
  for (const type of ["ABHA", "INSURANCE_MEMBER_ID", "EXTERNAL_MRN"]) {
    report(`The database refuses a ${type} in PatientIdentifier`,
      await refused(prisma.patientIdentifier.create({ data: { patientId: patient.id, type, value: `${run}-${type}` } })));
  }
  report("The database accepts an MRN in PatientIdentifier",
    !(await refused(prisma.patientIdentifier.create({ data: { patientId: other.id, type: "MRN", value: `${run}-MRN-direct` } }))));

  // 2. Routing.
  const add = (type: string, value: string, issuer?: string, patientId = patient.id) =>
    addPatientIdentifier({ facilityId, patientId, type, value, issuer, byUserId: staff.id });
  const abhaNumber = `91-${run}`;
  const abhaAddress = `ids${run}@abdm`;
  const member = `MEM-${run}`;
  const mrn = await add("MRN", `MRN-${run}`);
  report("MRN goes to PatientIdentifier", mrn.kind === "AAROGYA");
  const a1 = await add("ABHA", abhaNumber);
  const a2 = await add("ABHA", abhaAddress);
  const m1 = await add("INSURANCE_MEMBER_ID", member, "Star Health");
  report("ABHA number → ExternalIdentifier (ABHA number system)", a1.kind === "EXTERNAL" && a1.identifier.system === IDENTIFIER_SYSTEMS.ABHA_NUMBER);
  report("ABHA address → ExternalIdentifier (ABHA address system)", a2.kind === "EXTERNAL" && a2.identifier.system === IDENTIFIER_SYSTEMS.ABHA_ADDRESS);
  report("Insurer member ID → ExternalIdentifier, per-insurer system",
    m1.kind === "EXTERNAL" && m1.identifier.system === "https://aarogya.local/insurer-member/star-health", m1.kind);
  const ext = await prisma.externalIdentifier.findMany({ where: { facilityId, entityType: "PATIENT", entityId: patient.id } });
  report("All three are unverified mappings on this patient", ext.length === 3 && ext.every((e) => e.verificationStatus === "UNVERIFIED"));
  report("None of them is in PatientIdentifier",
    (await prisma.patientIdentifier.count({ where: { patientId: patient.id, value: { in: [abhaNumber, abhaAddress, member] } } })) === 0);

  // 3. Validation and collisions.
  report("An insurer member ID without its insurer is refused", await refused(add("INSURANCE_MEMBER_ID", `NOINS-${run}`)));
  report("An ABHA held by another patient is refused", await refused(add("ABHA", abhaNumber, undefined, other.id)));
  report("A patient in another facility can't be given an identifier here",
    await refused(addPatientIdentifier({ facilityId: "fac-amc-noida", patientId: patient.id, type: "ABHA", value: `X-${run}`, byUserId: staff.id })));
  report("UHID can't be added by hand", await refused(add("UHID", `U-${run}`)));

  // 4. The patient API's reader, and search.
  const listed = await listPatientIdentifiers(facilityId, patient.id);
  report("The patient API lists the MRN as an Aarogya identifier", listed.identifiers.some((i) => i.type === "MRN" && i.value === `MRN-${run}`));
  report("…and the external identifiers, labelled",
    ["ABHA number", "ABHA address", "Insurer member ID (star-health)"].every((l) => listed.externalIdentifiers.some((e) => e.label === l)),
    listed.externalIdentifiers.map((e) => e.label).join(", "));
  const byAbha = await prisma.patient.findMany({
    where: patientSearchWhere(facilityId, abhaNumber, await patientIdsByExternalIdentifier(facilityId, abhaNumber)), select: { id: true },
  });
  report("Searching an ABHA number finds the patient", byAbha.length === 1 && byAbha[0].id === patient.id);
  report("The migration's system rule matches the service's", externalSystemFor("INSURANCE_MEMBER_ID", "x", " Star Health & Allied ") === "https://aarogya.local/insurer-member/star-health-allied");

  // 5. FHIR export.
  const scope: PatientAccessScope = { patientId: patient.id, patientIds: [patient.id], facilityId, isSelf: true, allowedClasses: new Set(ALL) };
  const recipient = `ids-partner-${run}`;
  const consent = await createSharingRequest(scope, owner.id, { purpose: "REFERRAL", scopes: ["ALL_CLINICAL"], recipientType: "FACILITY", recipientIdentifier: recipient, recipientName: "Partner" });
  const exported = await exportPatientToFhir({ facilityId, patientId: patient.id, purpose: "REFERRAL", scopes: ["LAB"], consentId: consent.id, recipientIdentifier: recipient, byUserId: staff.id });
  const fhirPatient = (exported.bundle.entry as { resource: { resourceType: string; identifier?: { system: string; value: string }[] } }[])
    .find((e) => e.resource.resourceType === "Patient")?.resource;
  const fhirIds = fhirPatient?.identifier ?? [];
  report("The FHIR export carries the ABHA number", fhirIds.some((i) => i.system === IDENTIFIER_SYSTEMS.ABHA_NUMBER && i.value === abhaNumber));
  report("…and the insurer member ID", fhirIds.some((i) => i.value === member));

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
