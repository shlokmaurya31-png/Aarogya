/**
 * PHASE C1 — interoperability security and concurrency verification against a
 * REAL PostgreSQL database.
 *
 * This is the adversarial gate for the interoperability boundary. It assumes the
 * caller is hostile and tries, with two real facilities and real patients, to:
 *
 *   - map an ABHA onto another facility patient
 *   - map an HFR/HPR identifier across a facility boundary
 *   - read, grant or revoke another facility consent
 *   - export a patient with no consent, a revoked one, an expired one, a
 *     wrong-purpose one, a wrong-recipient one, or one that is too narrow
 *   - reach another facility exchange by id
 *   - collide idempotency keys across facilities
 *   - import a resource onto the wrong patient or the wrong facility
 *   - double-link the same national identifier under genuine concurrency
 *
 * IMPORTANT: not idempotent. Run against a FRESHLY migrated and seeded database.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-interoperability.ts
 */
import { PrismaClient } from "@prisma/client";
import {
  linkExternalIdentifier, unlinkExternalIdentifier, verifyExternalIdentifier, listExternalIdentifiers,
} from "../src/lib/hospital/interoperability/externalIdentity";
import {
  requestConsent, grantConsent, revokeConsent, getConsent, assertExchangeAuthorized, expireLapsedConsents,
} from "../src/lib/hospital/interoperability/consent";
import {
  createExchange, authorizeExchange, dispatchExchange, retryExchange, getExchange, buildIdempotencyKey,
} from "../src/lib/hospital/interoperability/exchange";
import { exportPatientToFhir } from "../src/lib/hospital/interoperability/fhir/export";
import { importFhirPayload } from "../src/lib/hospital/interoperability/fhir/import";
import { createTerminologyMapping, resolveExternalCode } from "../src/lib/hospital/interoperability/terminology";
import { StubExchangeAdapter } from "../src/lib/hospital/interoperability/adapters/abdm";
import { IDENTIFIER_SYSTEMS } from "../src/lib/hospital/interoperability/shared";

const prisma = new PrismaClient();
let pass = 0, fail = 0;
const failures: string[] = [];

function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

/** A call that MUST be refused. Silent success here is a security failure. */
async function mustReject(name: string, fn: () => Promise<unknown>, expect?: RegExp) {
  try {
    await fn();
    report(name, false, "call SUCCEEDED but should have been refused");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    report(name, expect ? expect.test(msg) : true, expect && !expect.test(msg) ? `wrong error: ${msg}` : msg.slice(0, 70));
  }
}

async function mustResolve(name: string, fn: () => Promise<unknown>) {
  try { await fn(); report(name, true); }
  catch (e) { report(name, false, e instanceof Error ? e.message : String(e)); }
}

async function main() {
  const tag = `c1-${Date.now()}`;
  const facA = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Medical Centre" } });
  const facB = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Noida Hospital" } });

  const staffA = await prisma.hospitalStaffProfile.findMany({ where: { facilityId: facA.id, status: "ACTIVE" }, take: 2 });
  const staffB = await prisma.hospitalStaffProfile.findMany({ where: { facilityId: facB.id, status: "ACTIVE" }, take: 1 });
  const [a1, a2] = staffA; const b1 = staffB[0];

  const patientsA = await prisma.patient.findMany({ where: { facilityId: facA.id }, take: 3 });
  const patA = patientsA[0], patA2 = patientsA[1];
  const patB = await prisma.patient.findFirstOrThrow({ where: { facilityId: facB.id } });
  const encA = await prisma.encounter.findFirstOrThrow({ where: { facilityId: facA.id, patientId: patA.id } })
    .catch(async () => prisma.encounter.findFirstOrThrow({ where: { facilityId: facA.id } }));

  console.log(`\n=== A=${facA.name} / B=${facB.name} ===\n`);

  // ══ 1. EXTERNAL IDENTITY — CROSS-FACILITY AND WRONG-ENTITY ════════════════
  console.log("── External identity mapping ──");

  const abha = `${tag}-ABHA-1`;
  await mustResolve("Link an ABHA to a patient in the caller facility",
    () => linkExternalIdentifier({
      facilityId: facA.id, entityType: "PATIENT", entityId: patA.id,
      system: IDENTIFIER_SYSTEMS.ABHA_NUMBER, value: abha, createdByStaffId: a1.id, byUserId: a1.userId,
    }));

  const linked = await prisma.externalIdentifier.findFirstOrThrow({ where: { facilityId: facA.id, value: abha } });
  report("A newly linked identifier is UNVERIFIED, never assumed verified",
    linked.verificationStatus === "UNVERIFIED" && linked.verifiedAt === null, `status=${linked.verificationStatus}`);

  await mustReject("Facility A cannot map an ABHA onto facility B patient",
    () => linkExternalIdentifier({
      facilityId: facA.id, entityType: "PATIENT", entityId: patB.id,
      system: IDENTIFIER_SYSTEMS.ABHA_NUMBER, value: `${tag}-X1`, byUserId: a1.userId,
    }), /not found/i);

  await mustReject("Facility B cannot map an identifier onto facility A patient",
    () => linkExternalIdentifier({
      facilityId: facB.id, entityType: "PATIENT", entityId: patA.id,
      system: IDENTIFIER_SYSTEMS.ABHA_NUMBER, value: `${tag}-X2`, byUserId: b1.userId,
    }), /not found/i);

  await mustReject("The same ABHA cannot be linked to a second patient in the facility",
    () => linkExternalIdentifier({
      facilityId: facA.id, entityType: "PATIENT", entityId: patA2.id,
      system: IDENTIFIER_SYSTEMS.ABHA_NUMBER, value: abha, byUserId: a1.userId,
    }), /already linked to a different record/i);

  await mustReject("An HPR professional number cannot be attached to a patient",
    () => linkExternalIdentifier({
      facilityId: facA.id, entityType: "PATIENT", entityId: patA2.id,
      system: IDENTIFIER_SYSTEMS.HPR, value: `${tag}-HPR-X`, byUserId: a1.userId,
    }), /identifies a STAFF/i);

  await mustReject("An ABHA cannot be attached to a facility",
    () => linkExternalIdentifier({
      facilityId: facA.id, entityType: "FACILITY", entityId: facA.id,
      system: IDENTIFIER_SYSTEMS.ABHA_NUMBER, value: `${tag}-ABHA-F`, byUserId: a1.userId,
    }), /identifies a PATIENT/i);

  await mustReject("A facility cannot claim ANOTHER facility HFR identifier",
    () => linkExternalIdentifier({
      facilityId: facA.id, entityType: "FACILITY", entityId: facB.id,
      system: IDENTIFIER_SYSTEMS.HFR, value: `${tag}-HFR-B`, byUserId: a1.userId,
    }), /not found/i);

  await mustReject("Facility A cannot map an HPR number onto facility B staff",
    () => linkExternalIdentifier({
      facilityId: facA.id, entityType: "STAFF", entityId: b1.id,
      system: IDENTIFIER_SYSTEMS.HPR, value: `${tag}-HPR-B`, byUserId: a1.userId,
    }), /not found/i);

  await mustResolve("Facility A can map its OWN HFR identifier",
    () => linkExternalIdentifier({
      facilityId: facA.id, entityType: "FACILITY", entityId: facA.id,
      system: IDENTIFIER_SYSTEMS.HFR, value: `${tag}-HFR-A`, byUserId: a1.userId,
    }));

  const identifierB = await linkExternalIdentifier({
    facilityId: facB.id, entityType: "PATIENT", entityId: patB.id,
    system: IDENTIFIER_SYSTEMS.ABHA_NUMBER, value: `${tag}-ABHA-B`, byUserId: b1.userId,
  });
  await mustReject("Facility A cannot unlink facility B mapping by id",
    () => unlinkExternalIdentifier({ facilityId: facA.id, identifierId: identifierB.id, byUserId: a1.userId }),
    /not found/i);

  const listA = await listExternalIdentifiers({ facilityId: facA.id });
  report("Identifier listing never returns another facility mapping",
    listA.every((i) => i.facilityId === facA.id) && !listA.some((i) => i.id === identifierB.id), `count=${listA.length}`);

  const verifyResult = await verifyExternalIdentifier({ facilityId: facA.id, identifierId: linked.id, byUserId: a1.userId });
  report("Verification against an unconfigured registry does NOT mark the mapping verified",
    verifyResult.verified === false && verifyResult.outcome === "NOT_CONFIGURED", `outcome=${verifyResult.outcome}`);
  const afterVerify = await prisma.externalIdentifier.findUniqueOrThrow({ where: { id: linked.id } });
  report("The stored mapping is still UNVERIFIED after an unconfigured verify attempt",
    afterVerify.verificationStatus === "UNVERIFIED");

  // Concurrent double-link of the SAME national identifier: exactly one wins.
  {
    const value = `${tag}-RACE-ABHA`;
    const attempt = (patientId: string) => linkExternalIdentifier({
      facilityId: facA.id, entityType: "PATIENT", entityId: patientId,
      system: IDENTIFIER_SYSTEMS.ABHA_NUMBER, value, byUserId: a1.userId,
    }).then(() => ({ ok: true }), () => ({ ok: false }));
    const rs = await Promise.all([attempt(patA2.id), attempt(patientsA[2]?.id ?? patA2.id)]);
    const count = await prisma.externalIdentifier.count({ where: { facilityId: facA.id, value } });
    report("Concurrent link of one ABHA to two patients: exactly one row survives",
      count === 1 && rs.filter((r) => r.ok).length === 1, `rows=${count} winners=${rs.filter((r) => r.ok).length}`);
  }

  // ══ 2. CONSENT — IDOR AND LIFECYCLE ══════════════════════════════════════
  console.log("\n── Consent ──");

  const consentB = await requestConsent({
    facilityId: facB.id, patientId: patB.id, purpose: "TREATMENT", scopes: ["ALL_CLINICAL"],
    recipientType: "FACILITY", recipientIdentifier: "recipient-b", byUserId: b1.userId,
  });

  await mustReject("Facility A cannot read facility B consent",
    () => getConsent(facA.id, consentB.id), /not found/i);
  await mustReject("Facility A cannot grant facility B consent",
    () => grantConsent({ facilityId: facA.id, consentId: consentB.id, grantedBy: "STAFF_RECORDED", byUserId: a1.userId }),
    /not found/i);
  await mustReject("Facility A cannot revoke facility B consent",
    () => revokeConsent({ facilityId: facA.id, consentId: consentB.id, byUserId: a1.userId }), /not found/i);

  await mustReject("A consent cannot be created for another facility patient",
    () => requestConsent({
      facilityId: facA.id, patientId: patB.id, purpose: "TREATMENT", scopes: ["LAB"],
      recipientType: "FACILITY", recipientIdentifier: "x", byUserId: a1.userId,
    }), /not found/i);

  await mustReject("A consent cannot be created already expired",
    () => requestConsent({
      facilityId: facA.id, patientId: patA.id, purpose: "TREATMENT", scopes: ["LAB"],
      recipientType: "FACILITY", recipientIdentifier: "x", expiresAt: new Date(Date.now() - 86400_000), byUserId: a1.userId,
    }), /must be in the future/i);

  await mustReject("An unknown data scope is refused",
    () => requestConsent({
      facilityId: facA.id, patientId: patA.id, purpose: "TREATMENT", scopes: ["EVERYTHING"],
      recipientType: "FACILITY", recipientIdentifier: "x", byUserId: a1.userId,
    }), /Unknown consent scope/i);

  const consentLab = await requestConsent({
    facilityId: facA.id, patientId: patA.id, purpose: "REFERRAL", scopes: ["LAB"],
    recipientType: "FACILITY", recipientIdentifier: "partner-1", recipientName: "Partner Hospital",
    expiresAt: new Date(Date.now() + 30 * 86400_000), createdByStaffId: a1.id, byUserId: a1.userId,
  });
  report("A new consent starts in REQUESTED, never pre-granted", consentLab.status === "REQUESTED");

  await mustReject("An ungranted consent does not authorize an exchange",
    () => assertExchangeAuthorized({
      facilityId: facA.id, patientId: patA.id, purpose: "REFERRAL", scopes: ["LAB"], consentId: consentLab.id,
    }), /not authorized|is REQUESTED/i);

  await grantConsent({ facilityId: facA.id, consentId: consentLab.id, grantedBy: "PATIENT", byUserId: a1.userId });

  await mustResolve("A granted consent authorizes its own scope and purpose",
    () => assertExchangeAuthorized({
      facilityId: facA.id, patientId: patA.id, purpose: "REFERRAL", scopes: ["LAB"], consentId: consentLab.id,
    }));

  await mustReject("Consent for LAB does not authorize MEDICATION",
    () => assertExchangeAuthorized({
      facilityId: facA.id, patientId: patA.id, purpose: "REFERRAL", scopes: ["MEDICATION"], consentId: consentLab.id,
    }), /does not cover/i);

  await mustReject("Consent for REFERRAL does not authorize INSURANCE",
    () => assertExchangeAuthorized({
      facilityId: facA.id, patientId: patA.id, purpose: "INSURANCE", scopes: ["LAB"], consentId: consentLab.id,
    }), /granted for REFERRAL/i);

  await mustReject("Consent does not authorize a DIFFERENT recipient",
    () => assertExchangeAuthorized({
      facilityId: facA.id, patientId: patA.id, purpose: "REFERRAL", scopes: ["LAB"],
      consentId: consentLab.id, recipientIdentifier: "someone-else",
    }), /different recipient/i);

  await mustReject("Consent for patient A does not authorize exporting patient A2",
    () => assertExchangeAuthorized({
      facilityId: facA.id, patientId: patA2.id, purpose: "REFERRAL", scopes: ["LAB"], consentId: consentLab.id,
    }), /different patient/i);

  await mustReject("A non-PATIENT_ACCESS purpose requires a consent at all",
    () => assertExchangeAuthorized({
      facilityId: facA.id, patientId: patA.id, purpose: "RESEARCH", scopes: ["LAB"], consentId: null,
    }), /requires a valid consent/i);

  // Expired consent, written directly to simulate the passage of time.
  {
    const expiring = await requestConsent({
      facilityId: facA.id, patientId: patA.id, purpose: "SECOND_OPINION", scopes: ["ALL_CLINICAL"],
      recipientType: "FACILITY", recipientIdentifier: "partner-2",
      expiresAt: new Date(Date.now() + 60_000), byUserId: a1.userId,
    });
    await grantConsent({ facilityId: facA.id, consentId: expiring.id, grantedBy: "PATIENT", byUserId: a1.userId });
    await prisma.interopConsent.update({ where: { id: expiring.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await mustReject("An EXPIRED consent does not authorize, even while its status still says GRANTED",
      () => assertExchangeAuthorized({
        facilityId: facA.id, patientId: patA.id, purpose: "SECOND_OPINION", scopes: ["LAB"], consentId: expiring.id,
      }), /expired/i);
    const swept = await expireLapsedConsents(facA.id);
    report("Lapsed consents can be swept to EXPIRED", swept.expired >= 1, `expired=${swept.expired}`);
  }

  // Concurrent grant: exactly one winner.
  {
    const c = await requestConsent({
      facilityId: facA.id, patientId: patA.id, purpose: "TREATMENT", scopes: ["LAB"],
      recipientType: "FACILITY", recipientIdentifier: "race", byUserId: a1.userId,
    });
    const attempt = () => grantConsent({ facilityId: facA.id, consentId: c.id, grantedBy: "PATIENT", byUserId: a1.userId })
      .then(() => ({ ok: true }), () => ({ ok: false }));
    const rs = await Promise.all([attempt(), attempt()]);
    report("Concurrent consent grant: exactly one winner", rs.filter((r) => r.ok).length === 1,
      `winners=${rs.filter((r) => r.ok).length}`);
  }

  // ══ 3. EXPORT — THE DISCLOSURE GATE ══════════════════════════════════════
  console.log("\n── FHIR export ──");

  await mustReject("A patient cannot be exported without any consent",
    () => exportPatientToFhir({
      facilityId: facA.id, patientId: patA.id, purpose: "REFERRAL", scopes: ["LAB"], byUserId: a1.userId,
    }), /requires a valid consent/i);

  await mustReject("Facility A cannot export a facility B patient",
    () => exportPatientToFhir({
      facilityId: facA.id, patientId: patB.id, purpose: "PATIENT_ACCESS", scopes: ["LAB"], byUserId: a1.userId,
    }), /not found/i);

  type ExportOut = Awaited<ReturnType<typeof exportPatientToFhir>>;
  const exportHolder: { value: ExportOut | null } = { value: null };
  await mustResolve("A consented export succeeds", async () => {
    exportHolder.value = await exportPatientToFhir({
      facilityId: facA.id, patientId: patA.id, purpose: "REFERRAL", scopes: ["LAB"],
      consentId: consentLab.id, actorStaffId: a1.id, byUserId: a1.userId, timestamp: new Date("2026-03-01T00:00:00Z"),
    });
  });

  const exported = exportHolder.value;
  if (exported) {
    const bundle = exported.bundle;
    report("Export produces a FHIR document Bundle with a Composition first",
      bundle.type === "document" && bundle.entry?.[0].resource?.resourceType === "Composition");
    const types = new Set(bundle.entry?.map((e) => e.resource?.resourceType));
    report("A LAB-scoped export contains NO medication resources", !types.has("MedicationRequest"),
      `types=${[...types].join(",")}`);
    report("The exported Patient carries the canonical id, not the ABHA",
      (bundle.entry?.find((e) => e.resource?.resourceType === "Patient")?.resource as { id?: string })?.id === patA.id);

    // Determinism: same inputs, same hash.
    const again = await exportPatientToFhir({
      facilityId: facA.id, patientId: patA.id, purpose: "REFERRAL", scopes: ["LAB"],
      consentId: consentLab.id, actorStaffId: a1.id, byUserId: a1.userId, timestamp: new Date("2026-03-01T00:00:00Z"),
    });
    report("Export is deterministic: identical inputs hash identically",
      again.bundleHash === exported.bundleHash);

    const prov = await prisma.interopProvenance.findFirst({
      where: { facilityId: facA.id, patientId: patA.id, direction: "OUTBOUND" }, orderBy: { recordedAt: "desc" },
    });
    report("Export records provenance with a DERIVED origin and a server-derived actor",
      !!prov && prov.dataOrigin === "DERIVED" && prov.actorUserId === a1.userId, `origin=${prov?.dataOrigin}`);
    report("Provenance stores a payload hash, not the payload itself",
      !!prov?.payloadHash && !!prov?.payloadBytes);
  }

  await mustReject("A wrong-patient encounter cannot be forced into an export",
    () => exportPatientToFhir({
      facilityId: facA.id, patientId: patA2.id, purpose: "PATIENT_ACCESS", scopes: ["ENCOUNTER"],
      encounterId: encA.patientId === patA2.id ? "nonexistent" : encA.id, byUserId: a1.userId,
    }), /does not belong|not found/i);

  // Revocation must block FUTURE export.
  await revokeConsent({ facilityId: facA.id, consentId: consentLab.id, reason: "patient withdrew", byUserId: a1.userId });
  await mustReject("A REVOKED consent immediately blocks further export",
    () => exportPatientToFhir({
      facilityId: facA.id, patientId: patA.id, purpose: "REFERRAL", scopes: ["LAB"],
      consentId: consentLab.id, byUserId: a1.userId,
    }), /revoked/i);

  // ══ 4. EXCHANGE — IDOR, IDEMPOTENCY, RETRY ═══════════════════════════════
  console.log("\n── Exchange ──");

  const consentEx = await requestConsent({
    facilityId: facA.id, patientId: patA.id, purpose: "TREATMENT", scopes: ["ALL_CLINICAL"],
    recipientType: "FACILITY", recipientIdentifier: "partner-ex",
    expiresAt: new Date(Date.now() + 30 * 86400_000), byUserId: a1.userId,
  });
  await grantConsent({ facilityId: facA.id, consentId: consentEx.id, grantedBy: "PATIENT", byUserId: a1.userId });

  const { exchange: ex1 } = await createExchange({
    facilityId: facA.id, patientId: patA.id, direction: "OUTBOUND", purpose: "TREATMENT",
    scopes: ["LAB"], destinationSystem: "ABDM", consentId: consentEx.id,
    requestedByStaffId: a1.id, byUserId: a1.userId,
  });
  report("Exchange is created in REQUESTED", ex1.status === "REQUESTED");

  const dup = await createExchange({
    facilityId: facA.id, patientId: patA.id, direction: "OUTBOUND", purpose: "TREATMENT",
    scopes: ["LAB"], destinationSystem: "ABDM", consentId: consentEx.id, byUserId: a1.userId,
  });
  report("An identical exchange intent is deduplicated, not duplicated",
    dup.deduplicated === true && dup.exchange.id === ex1.id);

  report("Idempotency keys are namespaced by facility",
    buildIdempotencyKey({ facilityId: facA.id, direction: "OUTBOUND", destinationSystem: "ABDM", purpose: "TREATMENT", scopes: ["LAB"], clientKey: "same" })
    !== buildIdempotencyKey({ facilityId: facB.id, direction: "OUTBOUND", destinationSystem: "ABDM", purpose: "TREATMENT", scopes: ["LAB"], clientKey: "same" }));

  await mustReject("Facility B cannot read facility A exchange",
    () => getExchange(facB.id, ex1.id), /not found/i);
  await mustReject("Facility B cannot authorize facility A exchange",
    () => authorizeExchange({ facilityId: facB.id, exchangeId: ex1.id, byUserId: b1.userId }), /not found/i);
  await mustReject("An exchange cannot be dispatched before it is authorized",
    () => dispatchExchange({ facilityId: facA.id, exchangeId: ex1.id, byUserId: a1.userId }), /Illegal exchange transition/i);

  await mustResolve("An exchange can be authorized",
    () => authorizeExchange({ facilityId: facA.id, exchangeId: ex1.id, authorizedByStaffId: a2?.id, byUserId: a1.userId }));

  // Dispatch against an unconfigured real adapter must FAIL, never report success.
  {
    const result = await dispatchExchange({ facilityId: facA.id, exchangeId: ex1.id, byUserId: a1.userId, actorStaffId: a1.id });
    report("Dispatch to an unconfigured ABDM adapter FAILS rather than claiming delivery",
      result.status === "FAILED" && !!result.failureReason, `status=${result.status}`);
    report("A failed exchange is never marked completed", result.completedAt === null);
  }

  // Retry budget is bounded.
  {
    const ex = await prisma.healthInformationExchange.findUniqueOrThrow({ where: { id: ex1.id } });
    await prisma.healthInformationExchange.update({ where: { id: ex.id }, data: { retryCount: ex.maxRetries } });
    await mustReject("Retry is refused once the retry budget is exhausted",
      () => retryExchange({ facilityId: facA.id, exchangeId: ex1.id, byUserId: a1.userId }), /exhausted/i);
  }

  // A stubbed adapter proves the COMPLETED path, and is explicitly labelled.
  {
    const { exchange } = await createExchange({
      facilityId: facA.id, patientId: patA.id, direction: "OUTBOUND", purpose: "TREATMENT",
      scopes: ["LAB"], destinationSystem: "ABDM", consentId: consentEx.id,
      idempotencyKey: `${tag}-stub`, byUserId: a1.userId,
    });
    await authorizeExchange({ facilityId: facA.id, exchangeId: exchange.id, byUserId: a1.userId });
    const done = await dispatchExchange(
      { facilityId: facA.id, exchangeId: exchange.id, byUserId: a1.userId, actorStaffId: a1.id },
      { adapter: new StubExchangeAdapter() }
    );
    report("A successful dispatch records COMPLETED with a bundle hash and resource count",
      done.status === "COMPLETED" && !!done.bundleHash && (done.resourceCount ?? 0) > 0,
      `status=${done.status} resources=${done.resourceCount}`);
  }

  // Consent revoked between authorization and dispatch must block the transfer.
  {
    const c = await requestConsent({
      facilityId: facA.id, patientId: patA.id, purpose: "TREATMENT", scopes: ["ALL_CLINICAL"],
      recipientType: "FACILITY", recipientIdentifier: "revoke-race",
      expiresAt: new Date(Date.now() + 86400_000), byUserId: a1.userId,
    });
    await grantConsent({ facilityId: facA.id, consentId: c.id, grantedBy: "PATIENT", byUserId: a1.userId });
    const { exchange } = await createExchange({
      facilityId: facA.id, patientId: patA.id, direction: "OUTBOUND", purpose: "TREATMENT",
      scopes: ["LAB"], destinationSystem: "ABDM", consentId: c.id,
      idempotencyKey: `${tag}-revoke-race`, byUserId: a1.userId,
    });
    await revokeConsent({ facilityId: facA.id, consentId: c.id, reason: "withdrawn", byUserId: a1.userId });
    await mustReject("Consent revoked after request blocks authorization",
      () => authorizeExchange({ facilityId: facA.id, exchangeId: exchange.id, byUserId: a1.userId }), /revoked/i);
  }

  // ══ 5. IMPORT — WRONG PATIENT, WRONG FACILITY, DUPLICATES ════════════════
  console.log("\n── FHIR import ──");

  const inboundPatient = (id: string) => JSON.stringify({
    resourceType: "Patient", id,
    identifier: [{ system: IDENTIFIER_SYSTEMS.ABHA_NUMBER, value: abha }],
    name: [{ text: patA.fullName }], gender: "female",
  });

  const imp1 = await importFhirPayload({
    facilityId: facA.id, rawBody: inboundPatient(`${tag}-ext-1`), sourceSystem: "PARTNER_HOSPITAL", byUserId: a1.userId,
  });
  report("An inbound Patient resolves to the local patient via the ABHA mapping",
    imp1.resources[0].localEntityId === patA.id, `resolved=${imp1.resources[0].localEntityId === patA.id}`);
  report("Import STAGES and never writes a clinical table",
    imp1.staged + imp1.conflicts === 1 && imp1.resources[0].status !== "IMPORTED");

  const dupImport = await importFhirPayload({
    facilityId: facA.id, rawBody: inboundPatient(`${tag}-ext-1`), sourceSystem: "PARTNER_HOSPITAL", byUserId: a1.userId,
  });
  report("Replaying the same external resource is idempotent", dupImport.duplicates === 1);

  // The SAME external id in facility B must not collide with facility A row.
  await mustResolve("The same external resource id in another facility does not collide",
    () => importFhirPayload({
      facilityId: facB.id, rawBody: JSON.stringify({ resourceType: "Patient", id: `${tag}-ext-1`, name: [{ text: "X" }] }),
      sourceSystem: "PARTNER_HOSPITAL", byUserId: b1.userId,
    }));

  // A mismatching demographic must CONFLICT, never auto-merge.
  {
    const hostile = JSON.stringify({
      resourceType: "Patient", id: `${tag}-ext-conflict`,
      identifier: [{ system: IDENTIFIER_SYSTEMS.ABHA_NUMBER, value: abha }],
      name: [{ text: "Completely Different Person" }], gender: "male", birthDate: "1900-01-01",
    });
    const res = await importFhirPayload({ facilityId: facA.id, rawBody: hostile, sourceSystem: "PARTNER_HOSPITAL", byUserId: a1.userId });
    report("A conflicting external patient is flagged CONFLICT, never auto-merged",
      res.conflicts === 1 && res.resources[0].status === "CONFLICT", `status=${res.resources[0].status}`);
    const local = await prisma.patient.findUniqueOrThrow({ where: { id: patA.id } });
    report("The local patient record is UNCHANGED by the conflicting import",
      local.fullName === patA.fullName && local.sex === patA.sex);
  }

  await mustReject("Import cannot attach a resource to another facility patient",
    () => importFhirPayload({
      facilityId: facA.id,
      rawBody: JSON.stringify({ resourceType: "Observation", id: `${tag}-obs-x`, status: "final", code: { text: "x" } }),
      sourceSystem: "PARTNER", patientId: patB.id, byUserId: a1.userId,
    }), /not found/i);

  {
    const res = await importFhirPayload({
      facilityId: facA.id,
      rawBody: JSON.stringify({ resourceType: "Bundle", type: "collection", entry: [{ resource: { resourceType: "Binary", id: "b1" } }] }),
      sourceSystem: "PARTNER", byUserId: a1.userId,
    }).then(() => null, (e: unknown) => e as Error);
    report("An unsupported resource type is rejected at the boundary",
      !!res && /unsupported resourceType/i.test(res.message));
  }

  {
    const res = await importFhirPayload({
      facilityId: facA.id, rawBody: '{"resourceType":"Patient","__proto__":{"admin":true}}',
      sourceSystem: "PARTNER", byUserId: a1.userId,
    }).then(() => null, (e: unknown) => e as Error);
    report("A prototype-pollution payload is rejected", !!res && /forbidden key/i.test(res.message));
  }

  const inboundProv = await prisma.interopProvenance.findFirst({
    where: { facilityId: facA.id, direction: "INBOUND", sourceSystem: "PARTNER_HOSPITAL" },
    orderBy: { recordedAt: "desc" },
  });
  report("Imported data is recorded with EXTERNAL origin, never LOCAL",
    inboundProv?.dataOrigin === "EXTERNAL", `origin=${inboundProv?.dataOrigin}`);

  // ══ 6. TERMINOLOGY ═══════════════════════════════════════════════════════
  console.log("\n── Terminology ──");

  await createTerminologyMapping({
    facilityId: facA.id, domain: "DIAGNOSIS", localSystem: "AAROGYA", localCode: `${tag}-DX`,
    externalSystem: "http://snomed.info/sct", externalCode: "74400008", externalDisplay: "Appendicitis",
    byUserId: a1.userId,
  });
  const resolved = await resolveExternalCode({
    facilityId: facA.id, domain: "DIAGNOSIS", localSystem: "AAROGYA", localCode: `${tag}-DX`,
    externalSystem: "http://snomed.info/sct",
  });
  report("A mapped local code resolves to its external coding", resolved?.code === "74400008");

  const unmapped = await resolveExternalCode({
    facilityId: facA.id, domain: "DIAGNOSIS", localSystem: "AAROGYA", localCode: `${tag}-UNMAPPED`,
    externalSystem: "http://snomed.info/sct",
  });
  report("An unmapped code resolves to NULL so mappers emit text instead of guessing", unmapped === null);

  const crossFacility = await resolveExternalCode({
    facilityId: facB.id, domain: "DIAGNOSIS", localSystem: "AAROGYA", localCode: `${tag}-DX`,
    externalSystem: "http://snomed.info/sct",
  });
  report("A facility-specific mapping does not leak into another facility", crossFacility === null);

  // ══ 7. AUDIT COVERAGE ════════════════════════════════════════════════════
  console.log("\n── Audit coverage ──");
  for (const t of [
    "hospital.interop.externalIdentityLinked", "hospital.interop.consentCreated",
    "hospital.interop.consentGranted", "hospital.interop.consentRevoked",
    "hospital.interop.exchangeRequested", "hospital.interop.exchangeAuthorized",
    "hospital.interop.exchangeFailed", "hospital.interop.fhirExported",
    "hospital.interop.externalResourceImported", "hospital.interop.externalMappingConflict",
    "hospital.interop.terminologyMapped",
  ]) {
    const n = await prisma.auditEvent.count({ where: { type: t } });
    report(`Audit event emitted: ${t}`, n > 0, `count=${n}`);
  }

  // The audit detail must contain only a masked identifier, never the raw value.
  const linkEvents = await prisma.auditEvent.findMany({
    where: { type: "hospital.interop.externalIdentityLinked", facilityId: facA.id }, take: 50,
  });
  const leaked = linkEvents.filter((e) => JSON.stringify(e.detail ?? {}).includes(abha)).length;
  report("The full ABHA value is NOT written into the audit detail", leaked === 0, `events=${linkEvents.length}`);

  console.log("\n════════════════════════════════════════");
  console.log(`PHASE C1 INTEROPERABILITY — PASS ${pass} / FAIL ${fail}`);
  if (failures.length) { console.log("Failures:"); failures.forEach((f) => console.log(`  - ${f}`)); }
  console.log("════════════════════════════════════════\n");
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
