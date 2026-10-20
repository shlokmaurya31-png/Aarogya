/**
 * Workflow spine §9 step 9c: access, identity, interoperability and workforce.
 *
 *   1. Break-glass (SENSITIVE): activated, completed; another revoked; a lapsed
 *      one expired by the sweep, each with its event; never the reason.
 *   2. Privacy (SENSITIVE): a data-subject request created and moved through
 *      review; a legal hold set and cleared (LegalHoldSet), compare-and-set.
 *   3. Exchange: HealthInformationExchangeRequested, then a status event for
 *      authorize, dispatch (processing, completed) and for a rejection.
 *   4. External identifiers: linked, verified, unlinked; the registry as a
 *      code, never the identifier value.
 *   5. FHIR import review: ImportedResourceReviewed once; a second decision is
 *      refused.
 *   6. Workforce: StaffAuthorizationChanged for a department assignment
 *      (started, ended), a credential (recorded, verified, suspended) and a
 *      privilege (granted, suspended, reinstated, revoked), each naming whose.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-access-identity-events.ts
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { registerPatient } from "../src/lib/patient/registration";
import { activateBreakGlass, completeBreakGlass, revokeBreakGlass, expireLapsedBreakGlass } from "../src/lib/auth/authorize/breakGlass";
import { createPrivacyRequest, transitionPrivacyRequest, setLegalHold } from "../src/lib/auth/authorize/privacy";
import { requestConsent, grantConsent } from "../src/lib/consent";
import { createExchange, authorizeExchange, rejectExchange, dispatchExchange } from "../src/lib/hospital/interoperability/exchange";
import { StubExchangeAdapter } from "../src/lib/hospital/interoperability/adapters/abdm";
import { linkExternalIdentifier, verifyExternalIdentifier, unlinkExternalIdentifier } from "../src/lib/hospital/interoperability/externalIdentity";
import { IDENTIFIER_SYSTEMS } from "../src/lib/hospital/interoperability/shared";
import { importFhirPayload, reviewImportedResource } from "../src/lib/hospital/interoperability/fhir/import";
import { createAssignment, endAssignment, createCredential, verifyCredential, suspendCredential, grantPrivilege, suspendPrivilege, reinstatePrivilege, revokePrivilege } from "../src/lib/hospital/workforce/service";
import { staffAtFacilityWhere } from "../src/lib/auth/staffFacility";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
type Payload = Record<string, unknown>;
const rejects = <T>(p: Promise<T>) => p.then(() => false, () => true);

async function main() {
  const run = Date.now().toString(36);
  const secret = `secret ${run}`;
  const facilityId = "fac-amc-pune";
  const staffWhere = (role: string) => ({ AND: [staffAtFacilityWhere(facilityId), { user: { role } }] }) as never;
  const doctor = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: staffWhere("DOCTOR"), orderBy: { id: "asc" } });
  const admin = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: staffWhere("HOSPITAL_ADMIN"), orderBy: { id: "asc" } });
  const nurse = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: staffWhere("NURSE"), orderBy: { id: "asc" } });
  const by = doctor.userId;
  const patient = await registerPatient({ facilityId, byUserId: by, fullName: `Access Identity ${run}`, sex: "F", ageYears: 33 });
  const payloads = async (type: string, aggregateId: string) => (await prisma.domainEventOutbox.findMany({ where: { eventType: type, aggregateId }, orderBy: { seq: "asc" } })).map((e) => e.payload as Payload);
  const moves = (ps: Payload[]) => ps.map((p) => `${p.from}>${p.to}`).join();
  const all: Payload[] = [];
  const keep = async (type: string, id: string) => { const ps = await payloads(type, id); all.push(...ps); return ps; };
  const reason = `Emergency reason long enough ${secret}`;

  // 1. Break-glass.
  const w1 = await activateBreakGlass({ facilityId, patientId: patient.id, actorUserId: by, actorStaffId: doctor.id, reason, emergencyContext: "LIFE_THREATENING" });
  await completeBreakGlass({ facilityId, breakGlassId: w1.id, actorUserId: by });
  const w2 = await activateBreakGlass({ facilityId, patientId: patient.id, actorUserId: by, actorStaffId: doctor.id, reason, emergencyContext: "UNCONSCIOUS_PATIENT" });
  await revokeBreakGlass({ facilityId, breakGlassId: w2.id, actorUserId: admin.userId, reason: secret });
  const w3 = await activateBreakGlass({ facilityId, patientId: patient.id, actorUserId: by, actorStaffId: doctor.id, reason, emergencyContext: "MASS_CASUALTY", durationMs: 1 });
  await new Promise((r) => setTimeout(r, 20));
  const swept = await expireLapsedBreakGlass(facilityId);
  const bg = [await keep("BreakGlassStatusChanged", w1.id), await keep("BreakGlassStatusChanged", w2.id), await keep("BreakGlassStatusChanged", w3.id)].map(moves);
  report("Break-glass: null>ACTIVE then ACTIVE>COMPLETED; ACTIVE>REVOKED; a lapsed window ACTIVE>EXPIRED by the sweep",
    bg.join(" | ") === "null>ACTIVE,ACTIVE>COMPLETED | null>ACTIVE,ACTIVE>REVOKED | null>ACTIVE,ACTIVE>EXPIRED" && swept.expired >= 1, bg.join(" | "));
  report("…a second sweep expires nothing more for it", (await expireLapsedBreakGlass(facilityId)) && (await payloads("BreakGlassStatusChanged", w3.id)).length === 2);

  // 2. Privacy.
  const pr = await createPrivacyRequest({ facilityId, patientId: patient.id, requestType: "DELETION_REQUEST", requesterType: "STAFF_ON_BEHALF", requesterUserId: by, reason: secret });
  await transitionPrivacyRequest({ facilityId, privacyRequestId: pr.id, to: "UNDER_REVIEW", byUserId: admin.userId });
  await setLegalHold({ facilityId, privacyRequestId: pr.id, hold: true, reason: secret, byUserId: admin.userId });
  report("…a request under legal hold can't be actioned",
    await transitionPrivacyRequest({ facilityId, privacyRequestId: pr.id, to: "APPROVED", decisionNote: secret, byUserId: admin.userId })
      .then(() => rejects(transitionPrivacyRequest({ facilityId, privacyRequestId: pr.id, to: "ACTIONED", byUserId: admin.userId }))));
  await setLegalHold({ facilityId, privacyRequestId: pr.id, hold: false, byUserId: admin.userId });
  await transitionPrivacyRequest({ facilityId, privacyRequestId: pr.id, to: "ACTIONED", byUserId: admin.userId });
  const prE = await keep("PrivacyRequestStatusChanged", pr.id);
  const holds = await keep("LegalHoldSet", pr.id);
  report("Privacy request: null>REQUESTED, REQUESTED>UNDER_REVIEW, UNDER_REVIEW>APPROVED, APPROVED>ACTIONED (DELETION_REQUEST); never the reason or note",
    moves(prE) === "null>REQUESTED,REQUESTED>UNDER_REVIEW,UNDER_REVIEW>APPROVED,APPROVED>ACTIONED" && prE.every((p) => p.requestType === "DELETION_REQUEST"), moves(prE));
  report("LegalHoldSet: placed then cleared", holds.map((p) => p.hold).join() === "true,false");

  // 3. Exchange.
  const consent = await requestConsent({ facilityId, patientId: patient.id, purpose: "TREATMENT", scopes: ["LAB"], recipientType: "FACILITY", recipientIdentifier: `HFR-${run}`, byUserId: by });
  await grantConsent({ facilityId, consentId: consent.id, grantedBy: "STAFF_RECORDED", byUserId: by });
  const { exchange } = await createExchange({ facilityId, patientId: patient.id, direction: "OUTBOUND", purpose: "TREATMENT", scopes: ["LAB"], destinationSystem: "ABDM", consentId: consent.id, idempotencyKey: `aie-${run}`, byUserId: by });
  await authorizeExchange({ facilityId, exchangeId: exchange.id, authorizedByStaffId: admin.id, byUserId: admin.userId });
  await dispatchExchange({ facilityId, exchangeId: exchange.id, byUserId: by }, { adapter: new StubExchangeAdapter() });
  const req = await keep("HealthInformationExchangeRequested", exchange.id);
  const exE = await keep("HealthInformationExchangeStatusChanged", exchange.id);
  report("Exchange: Requested (OUTBOUND, TREATMENT, LAB, the consent), then REQUESTED>AUTHORIZED, AUTHORIZED>PROCESSING, PROCESSING>COMPLETED (resource count)",
    req.length === 1 && req[0].purpose === "TREATMENT" && (req[0].scopes as string[]).join() === "LAB" && req[0].consentId === consent.id
      && moves(exE) === "REQUESTED>AUTHORIZED,AUTHORIZED>PROCESSING,PROCESSING>COMPLETED" && typeof exE[2].resourceCount === "number", moves(exE));
  const { exchange: ex2 } = await createExchange({ facilityId, patientId: patient.id, direction: "OUTBOUND", purpose: "TREATMENT", scopes: ["LAB"], destinationSystem: "ABDM", consentId: consent.id, idempotencyKey: `aie2-${run}`, byUserId: by });
  await rejectExchange({ facilityId, exchangeId: ex2.id, reason: secret, byUserId: admin.userId });
  report("A rejected exchange: REQUESTED>REJECTED, never the reason", moves(await keep("HealthInformationExchangeStatusChanged", ex2.id)) === "REQUESTED>REJECTED");

  // 4. External identifiers.
  const abha = `${run}-ABHA-secret`;
  const ident = await linkExternalIdentifier({ facilityId, entityType: "PATIENT", entityId: patient.id, system: IDENTIFIER_SYSTEMS.ABHA_NUMBER, value: abha, byUserId: by });
  const verification = await verifyExternalIdentifier({ facilityId, identifierId: ident.id, byUserId: by });
  await unlinkExternalIdentifier({ facilityId, identifierId: ident.id, reason: secret, byUserId: by });
  const idE = await keep("ExternalIdentifierStatusChanged", ident.id);
  // A registry answer emits VERIFIED / VERIFICATION_FAILED; a transport failure is sync bookkeeping and emits nothing.
  const expected = verification.outcome === "OK" ? ["LINKED", verification.verified ? "VERIFIED" : "VERIFICATION_FAILED", "UNLINKED"] : ["LINKED", "UNLINKED"];
  report(`External identifier: ${expected.join(", ")} (registry outcome ${verification.outcome}); the registry as ABHA_NUMBER, never the value`,
    idE.map((p) => p.change).join() === expected.join() && idE.at(-1)?.status === "REVOKED"
      && idE.every((p) => p.system === "ABHA_NUMBER" && p.entityId === patient.id) && !JSON.stringify(idE).includes("ABHA-secret"), idE.map((p) => p.change).join());

  // 5. FHIR import review.
  const imp = await importFhirPayload({ facilityId, rawBody: JSON.stringify({ resourceType: "Patient", id: `ext-${run}`, name: [{ text: `Imported ${secret}` }], gender: "female" }), sourceSystem: "PARTNER_HOSPITAL", byUserId: by });
  const resourceId = (await prisma.importedResource.findFirstOrThrow({ where: { facilityId, externalResourceId: imp.resources[0].externalResourceId }, orderBy: { id: "desc" } })).id;
  await reviewImportedResource({ facilityId, importedResourceId: resourceId, decision: "REJECTED", note: secret, byUserId: admin.userId });
  const irE = await keep("ImportedResourceReviewed", resourceId);
  report("Import review: ImportedResourceReviewed once (REJECTED); never the resource or note",
    irE.length === 1 && irE[0].decision === "REJECTED" && !JSON.stringify(irE).includes("Imported"));
  report("…a second decision is refused", await rejects(reviewImportedResource({ facilityId, importedResourceId: resourceId, decision: "MAPPED", byUserId: admin.userId })));

  // 6. Workforce.
  const dept = await prisma.department.findFirst({ where: { facilityId }, orderBy: { id: "asc" } });
  const asg = await createAssignment({ facilityId, staffId: nurse.id, departmentId: dept?.id, createdByStaffId: admin.id, byUserId: admin.userId });
  await endAssignment({ facilityId, assignmentId: asg.id, byUserId: admin.userId });
  const cred = await createCredential({ facilityId, staffId: nurse.id, credentialType: "REGISTRATION", name: `Reg ${secret}`, credentialNumber: `REG-${secret}`, createdByStaffId: admin.id, byUserId: admin.userId });
  await verifyCredential({ facilityId, credentialId: cred.id, verifiedByStaffId: doctor.id, byUserId: by });
  await suspendCredential({ facilityId, credentialId: cred.id, byUserId: admin.userId });
  const priv = await grantPrivilege({ facilityId, staffId: nurse.id, privilegeType: "IV_CANNULATION", grantedByStaffId: admin.id, notes: secret, byUserId: admin.userId });
  await suspendPrivilege({ facilityId, privilegeId: priv.id, byUserId: admin.userId });
  await reinstatePrivilege({ facilityId, privilegeId: priv.id, byUserId: admin.userId });
  await revokePrivilege({ facilityId, privilegeId: priv.id, revokedByStaffId: admin.id, byUserId: admin.userId });
  const wf = (await keep("StaffAuthorizationChanged", nurse.id)).filter((p) => [asg.id, cred.id, priv.id].includes(String(p.recordId)));
  report("StaffAuthorizationChanged per change, naming the nurse: DEPARTMENT start/end, CREDENTIAL recorded/verified/suspended, PRIVILEGE granted/suspended/reinstated/revoked",
    wf.map((p) => `${p.changeType}:${p.from}>${p.to}`).join() === "DEPARTMENT:null>ACTIVE,DEPARTMENT:ACTIVE>ENDED,CREDENTIAL:null>PENDING,CREDENTIAL:PENDING>VERIFIED,CREDENTIAL:VERIFIED>SUSPENDED,PRIVILEGE:null>ACTIVE,PRIVILEGE:ACTIVE>SUSPENDED,PRIVILEGE:SUSPENDED>ACTIVE,PRIVILEGE:ACTIVE>REVOKED"
      && wf.every((p) => p.subjectStaffId === nurse.id) && wf[2].credentialType === "REGISTRATION", wf.map((p) => `${p.changeType}:${p.from}>${p.to}`).join());

  report("No payload carries the free text, reason or identifier value the calls were given", all.length > 25 && !JSON.stringify(all).includes(secret), `${all.length} payloads`);

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
