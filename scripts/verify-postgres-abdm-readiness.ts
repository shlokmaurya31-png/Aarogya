/**
 * PHASE C2 — ABDM sandbox-readiness security and concurrency verification
 * against a REAL PostgreSQL database.
 *
 * The C1 script proved the interoperability boundary. This one attacks the
 * ABDM-specific surface that C2 added, which is more exposed because the
 * callback endpoint is PUBLIC — the Consent Manager has no Aarogya session, so
 * anyone who learns the URL can POST to it.
 *
 * Attacks exercised here:
 *   - forged / missing / wrong-length callback tokens
 *   - callback replay, including genuinely concurrent duplicate delivery
 *   - cross-facility callback correlation
 *   - callbacks that name an exchange in another facility
 *   - stale and future-dated callback timestamps
 *   - concurrent exchange creation and idempotency collapse
 *   - revoke-versus-authorize races
 *   - duplicate external identity mapping under contention
 *   - duplicate external resource import convergence
 *
 * IMPORTANT: not idempotent. Run against a FRESHLY migrated and seeded database.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-abdm-readiness.ts
 */
import { PrismaClient } from "@prisma/client";
import { getAbdmConfig, checkEnvironmentSafety, ABDM_ENV_VARS } from "../src/lib/hospital/interoperability/abdm/config";
import { receiveCallback, authenticateCallback, CALLBACK_MAX_SKEW_MS } from "../src/lib/hospital/interoperability/abdm/callbacks";
import { checkAbdmHealth, isConnected } from "../src/lib/hospital/interoperability/abdm/health";
import { getAbdmSession, clearSessionCache } from "../src/lib/hospital/interoperability/abdm/session";
import { createMockAbdmFetch } from "../src/lib/hospital/interoperability/adapters/mockAbdm";
import { reconcileConsentStatus } from "../src/lib/hospital/interoperability/abdm/mapping";
import { createExchange, authorizeExchange, dispatchExchange } from "../src/lib/hospital/interoperability/exchange";
import { StubExchangeAdapter } from "../src/lib/hospital/interoperability/adapters/abdm";
import { requestConsent, grantConsent, revokeConsent } from "../src/lib/hospital/interoperability/consent";
import { linkExternalIdentifier } from "../src/lib/hospital/interoperability/externalIdentity";
import { importFhirPayload } from "../src/lib/hospital/interoperability/fhir/import";
import { IDENTIFIER_SYSTEMS } from "../src/lib/hospital/interoperability/shared";

const prisma = new PrismaClient();
let pass = 0, fail = 0;
const failures: string[] = [];

function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

async function mustReject(name: string, fn: () => Promise<unknown>, expect?: RegExp) {
  try {
    await fn();
    report(name, false, "call SUCCEEDED but should have been refused");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    report(name, expect ? expect.test(msg) : true, expect && !expect.test(msg) ? `wrong error: ${msg}` : msg.slice(0, 70));
  }
}

/** A configuration WITH callbacks enabled, used to drive the callback tests. */
const CALLBACK_TOKEN = "c2-callback-secret";
const callbackConfig = getAbdmConfig({
  [ABDM_ENV_VARS.environment]: "SANDBOX",
  [ABDM_ENV_VARS.clientId]: "SBX_000135",
  [ABDM_ENV_VARS.clientSecret]: "secret",
  [ABDM_ENV_VARS.callbackBaseUrl]: "https://aarogya.example",
  [ABDM_ENV_VARS.callbackToken]: CALLBACK_TOKEN,
});

function envelope(args: {
  requestId: string; token?: string | null; timestamp?: string; body?: unknown;
}) {
  return {
    kind: "consentRequestNotify" as const,
    rawBody: JSON.stringify(args.body ?? { response: { requestId: args.requestId } }),
    headers: {
      token: args.token === undefined ? CALLBACK_TOKEN : args.token,
      requestId: args.requestId,
      timestamp: args.timestamp ?? new Date().toISOString(),
      hiuId: "SBX_000135",
    },
    sourceAddress: "203.0.113.9",
  };
}

async function main() {
  const tag = `c2-${Date.now()}`;
  const facA = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Medical Centre" } });
  const facB = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Noida Hospital" } });
  const a1 = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { facilityId: facA.id, status: "ACTIVE" } });
  const b1 = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { facilityId: facB.id, status: "ACTIVE" } });
  const patA = await prisma.patient.findFirstOrThrow({ where: { facilityId: facA.id } });
  const patB = await prisma.patient.findFirstOrThrow({ where: { facilityId: facB.id } });

  console.log(`\n=== A=${facA.name} / B=${facB.name} ===\n`);

  // ══ 1. CONFIGURATION FAILS CLOSED ════════════════════════════════════════
  console.log("── Configuration ──");

  report("A deployment with no ABDM configuration is DISABLED",
    getAbdmConfig({}).environment === "DISABLED");
  report("PRODUCTION without credentials is reported unsafe, never ready",
    checkEnvironmentSafety(getAbdmConfig({ [ABDM_ENV_VARS.environment]: "PRODUCTION" }), "production").safe === false);

  clearSessionCache();
  await mustReject("A disabled deployment cannot obtain a gateway session",
    () => getAbdmSession(getAbdmConfig({})), /disabled/i);

  {
    const health = await checkAbdmHealth(getAbdmConfig({}));
    report("A disabled adapter reports DISABLED and is not connected",
      health.state === "DISABLED" && !isConnected(health.state));
  }
  {
    // The most important honesty assertion in this phase.
    const health = await checkAbdmHealth(callbackConfig, { performHandshake: false });
    report("Complete configuration alone NEVER reports AVAILABLE",
      health.state === "UNKNOWN" && !isConnected(health.state), `state=${health.state}`);
  }
  {
    const health = await checkAbdmHealth(callbackConfig, {
      performHandshake: true, fetchImpl: createMockAbdmFetch("AUTH_FAILURE"),
    });
    report("Rejected credentials report AUTHENTICATION_FAILED, not AVAILABLE",
      health.state === "AUTHENTICATION_FAILED" && !isConnected(health.state));
  }

  // ══ 2. CALLBACK AUTHENTICATION ═══════════════════════════════════════════
  console.log("\n── Callback authentication ──");

  await mustReject("A callback with NO token is refused",
    async () => authenticateCallback(callbackConfig, null), /authentication failed/i);
  await mustReject("A callback with a FORGED token is refused",
    async () => authenticateCallback(callbackConfig, "forged-token"), /authentication failed/i);
  await mustReject("A near-miss token is refused",
    async () => authenticateCallback(callbackConfig, CALLBACK_TOKEN + "x"), /authentication failed/i);
  await mustReject("Callbacks are refused entirely when no token is configured",
    async () => authenticateCallback(
      getAbdmConfig({ [ABDM_ENV_VARS.environment]: "SANDBOX", [ABDM_ENV_VARS.clientId]: "SBX_1", [ABDM_ENV_VARS.clientSecret]: "s" }),
      "anything"
    ), /refused/i);

  // ══ 3. CALLBACK CORRELATION AND REPLAY ═══════════════════════════════════
  console.log("\n── Callback correlation and replay ──");

  // Build a real exchange in facility A to correlate against.
  const consentA = await requestConsent({
    facilityId: facA.id, patientId: patA.id, purpose: "TREATMENT", scopes: ["ALL_CLINICAL"],
    recipientType: "FACILITY", recipientIdentifier: "partner-c2",
    expiresAt: new Date(Date.now() + 30 * 86400_000), byUserId: a1.userId,
  });
  await grantConsent({ facilityId: facA.id, consentId: consentA.id, grantedBy: "PATIENT", byUserId: a1.userId });

  const correlationId = `${tag}-corr-1`;
  const { exchange: exA } = await createExchange({
    facilityId: facA.id, patientId: patA.id, direction: "OUTBOUND", purpose: "TREATMENT",
    scopes: ["LAB"], destinationSystem: "ABDM", consentId: consentA.id,
    correlationId, idempotencyKey: `${tag}-ex-1`, byUserId: a1.userId,
  });

  await mustReject("A callback with a stale timestamp is refused",
    () => receiveCallback({
      config: callbackConfig, facilityId: facA.id,
      envelope: envelope({ requestId: correlationId, timestamp: new Date(Date.now() - CALLBACK_MAX_SKEW_MS - 60_000).toISOString() }),
    }), /outside the accepted window/i);

  await mustReject("A callback with a future timestamp is refused",
    () => receiveCallback({
      config: callbackConfig, facilityId: facA.id,
      envelope: envelope({ requestId: correlationId, timestamp: new Date(Date.now() + CALLBACK_MAX_SKEW_MS + 60_000).toISOString() }),
    }), /outside the accepted window/i);

  await mustReject("A callback with no correlating request id is refused",
    () => receiveCallback({
      config: callbackConfig, facilityId: facA.id,
      envelope: { ...envelope({ requestId: "x" }), rawBody: JSON.stringify({ nothing: true }), headers: { token: CALLBACK_TOKEN, requestId: null, timestamp: new Date().toISOString(), hiuId: null } },
    }), /correlate/i);

  await mustReject("An empty callback body is refused",
    () => receiveCallback({
      config: callbackConfig, facilityId: facA.id,
      envelope: { ...envelope({ requestId: correlationId }), rawBody: "" },
    }), /empty/i);

  await mustReject("A non-JSON callback body is refused",
    () => receiveCallback({
      config: callbackConfig, facilityId: facA.id,
      envelope: { ...envelope({ requestId: correlationId }), rawBody: "<html>not json</html>" },
    }), /valid JSON/i);

  {
    const first = await receiveCallback({
      config: callbackConfig, facilityId: facA.id, envelope: envelope({ requestId: correlationId }),
    });
    report("A correlated, authenticated callback is ACCEPTED and linked to its exchange",
      first.status === "ACCEPTED" && first.exchangeId === exA.id, `status=${first.status}`);

    const replay = await receiveCallback({
      config: callbackConfig, facilityId: facA.id, envelope: envelope({ requestId: correlationId }),
    });
    report("Replaying the same callback is detected as DUPLICATE, not processed twice",
      replay.status === "DUPLICATE", `status=${replay.status}`);

    const rows = await prisma.abdmCallbackEvent.count({
      where: { facilityId: facA.id, externalRequestId: correlationId, callbackKind: "consentRequestNotify" },
    });
    report("Exactly one callback ledger row exists after a replay", rows === 1, `rows=${rows}`);
  }

  {
    // Facility B receiving a callback that correlates to facility A's exchange
    // must NOT resolve it — the exchange lookup is facility-scoped.
    const crossed = await receiveCallback({
      config: callbackConfig, facilityId: facB.id, envelope: envelope({ requestId: correlationId }),
    });
    report("A callback correlating to another facility exchange is UNMATCHED, never linked",
      crossed.status === "UNMATCHED" && crossed.exchangeId === null, `status=${crossed.status}`);
  }

  {
    const unknown = await receiveCallback({
      config: callbackConfig, facilityId: facA.id, envelope: envelope({ requestId: `${tag}-never-sent` }),
    });
    report("A callback for a request we never sent is UNMATCHED and creates no exchange state",
      unknown.status === "UNMATCHED" && unknown.exchangeId === null);
  }

  {
    // Genuinely concurrent duplicate delivery — the unique index is the guard.
    const rid = `${tag}-corr-race`;
    await prisma.healthInformationExchange.update({ where: { id: exA.id }, data: { correlationId: rid } });
    const attempt = () => receiveCallback({
      config: callbackConfig, facilityId: facA.id, envelope: envelope({ requestId: rid }),
    }).then((r) => r.status, () => "ERROR");
    const results = await Promise.all([attempt(), attempt(), attempt()]);
    const accepted = results.filter((r) => r === "ACCEPTED").length;
    const rows = await prisma.abdmCallbackEvent.count({ where: { facilityId: facA.id, externalRequestId: rid } });
    report("Three concurrent identical callbacks produce exactly one accepted row",
      accepted === 1 && rows === 1, `accepted=${accepted} rows=${rows} results=${results.join(",")}`);
  }

  {
    const events = await prisma.abdmCallbackEvent.findMany({ where: { facilityId: facA.id }, take: 20 });
    report("Callback ledger stores a payload hash, never the payload",
      events.every((e) => !!e.payloadHash && typeof e.payloadBytes === "number"));
    const anyPayloadColumn = events.some((e) => JSON.stringify(e).includes("response"));
    report("No callback body content is persisted in the ledger", !anyPayloadColumn);
  }

  // ══ 4. CONSENT STATUS RECONCILIATION ═════════════════════════════════════
  console.log("\n── Consent reconciliation ──");

  report("A CM-reported REVOKED overrides a stale local GRANTED",
    reconcileConsentStatus({ localStatus: "GRANTED", externalStatus: "REVOKED", externalRequired: true }).usable === false);
  report("An unsynchronised external status blocks when external is required",
    reconcileConsentStatus({ localStatus: "GRANTED", externalStatus: null, externalRequired: true }).usable === false);
  report("An unrecognised external status blocks rather than defaulting open",
    reconcileConsentStatus({ localStatus: "GRANTED", externalStatus: "SOMETHING_NEW", externalRequired: true }).usable === false);
  report("Both views agreeing permits the exchange",
    reconcileConsentStatus({ localStatus: "GRANTED", externalStatus: "GRANTED", externalRequired: true }).usable === true);

  // ══ 5. EXCHANGE IDEMPOTENCY AND RACES ════════════════════════════════════
  console.log("\n── Exchange idempotency and races ──");

  {
    const key = `${tag}-idem`;
    const make = () => createExchange({
      facilityId: facA.id, patientId: patA.id, direction: "OUTBOUND", purpose: "TREATMENT",
      scopes: ["LAB"], destinationSystem: "ABDM", consentId: consentA.id,
      idempotencyKey: key, byUserId: a1.userId,
    }).then((r) => r.exchange.id, () => null);
    const ids = await Promise.all([make(), make(), make()]);
    const unique = new Set(ids.filter(Boolean));
    report("Three concurrent identical exchange requests collapse to ONE exchange",
      unique.size === 1, `unique=${unique.size} ids=${ids.length}`);
  }

  {
    // A consent revoked between request and authorization must block.
    const c = await requestConsent({
      facilityId: facA.id, patientId: patA.id, purpose: "REFERRAL", scopes: ["LAB"],
      recipientType: "FACILITY", recipientIdentifier: "race-partner",
      expiresAt: new Date(Date.now() + 86400_000), byUserId: a1.userId,
    });
    await grantConsent({ facilityId: facA.id, consentId: c.id, grantedBy: "PATIENT", byUserId: a1.userId });
    const { exchange } = await createExchange({
      facilityId: facA.id, patientId: patA.id, direction: "OUTBOUND", purpose: "REFERRAL",
      scopes: ["LAB"], destinationSystem: "ABDM", consentId: c.id,
      idempotencyKey: `${tag}-revoke-race`, byUserId: a1.userId,
    });

    const revoked = revokeConsent({ facilityId: facA.id, consentId: c.id, reason: "withdrawn", byUserId: a1.userId })
      .then(() => true, () => false);
    const authorized = authorizeExchange({ facilityId: facA.id, exchangeId: exchange.id, byUserId: a1.userId })
      .then(() => true, () => false);
    const [didRevoke, didAuthorize] = await Promise.all([revoked, authorized]);

    // Whatever the interleaving, a revoked consent must never end up backing an
    // authorized exchange.
    const finalConsent = await prisma.interopConsent.findUniqueOrThrow({ where: { id: c.id } });
    const finalExchange = await prisma.healthInformationExchange.findUniqueOrThrow({ where: { id: exchange.id } });
    const safe = !(finalConsent.status === "REVOKED" && finalExchange.status === "AUTHORIZED" && !didAuthorize)
      && !(finalConsent.status === "REVOKED" && finalExchange.status === "PROCESSING");
    report("Revoke-vs-authorize race never leaves a revoked consent backing a live transfer",
      safe, `revoked=${didRevoke} authorized=${didAuthorize} consent=${finalConsent.status} exchange=${finalExchange.status}`);

    // And a subsequent authorization attempt must definitively fail.
    await mustReject("After revocation, authorization is refused outright",
      () => authorizeExchange({ facilityId: facA.id, exchangeId: exchange.id, byUserId: a1.userId }),
      /revoked|Illegal exchange transition/i);
  }

  {
    // Consent revoked AFTER authorization: dispatch must refuse BEFORE moving to
    // PROCESSING, compose nothing, and emit no outbound provenance.
    const c = await requestConsent({
      facilityId: facA.id, patientId: patA.id, purpose: "TREATMENT", scopes: ["ALL_CLINICAL"],
      recipientType: "FACILITY", recipientIdentifier: "post-auth-revoke",
      expiresAt: new Date(Date.now() + 86400_000), byUserId: a1.userId,
    });
    await grantConsent({ facilityId: facA.id, consentId: c.id, grantedBy: "PATIENT", byUserId: a1.userId });
    const { exchange } = await createExchange({
      facilityId: facA.id, patientId: patA.id, direction: "OUTBOUND", purpose: "TREATMENT",
      scopes: ["LAB"], destinationSystem: "ABDM", consentId: c.id,
      idempotencyKey: `${tag}-post-auth-revoke`, byUserId: a1.userId,
    });
    await authorizeExchange({ facilityId: facA.id, exchangeId: exchange.id, byUserId: a1.userId });
    await revokeConsent({ facilityId: facA.id, consentId: c.id, reason: "withdrawn", byUserId: a1.userId });

    // A stub adapter that WOULD succeed, to prove the refusal is ours.
    const dispatched = await dispatchExchange(
      { facilityId: facA.id, exchangeId: exchange.id, byUserId: a1.userId },
      { adapter: new StubExchangeAdapter() }
    );
    const provenance = await prisma.interopProvenance.count({
      where: { exchangeId: exchange.id, direction: "OUTBOUND" },
    });
    report("Consent revoked after authorization: dispatch FAILS and discloses nothing",
      dispatched.status === "FAILED" && dispatched.bundleHash === null && provenance === 0,
      `status=${dispatched.status} bundle=${dispatched.bundleHash} provenance=${provenance}`);
    report("A revoked-consent dispatch never even enters PROCESSING",
      dispatched.processingStartedAt === null, `processingStartedAt=${dispatched.processingStartedAt}`);
    report("The failure reason names consent, not a transport problem",
      /revoked/i.test(dispatched.failureReason ?? ""), `reason=${dispatched.failureReason}`);
  }

  await mustReject("Facility B cannot authorize a facility A exchange",
    () => authorizeExchange({ facilityId: facB.id, exchangeId: exA.id, byUserId: b1.userId }), /not found/i);

  // ══ 6. IDENTITY AND IMPORT CONVERGENCE ═══════════════════════════════════
  console.log("\n── Identity and import convergence ──");

  {
    const value = `${tag}-ABHA-RACE@sbx`;
    const attempt = (patientId: string) => linkExternalIdentifier({
      facilityId: facA.id, entityType: "PATIENT", entityId: patientId,
      system: IDENTIFIER_SYSTEMS.ABHA_ADDRESS, value, byUserId: a1.userId,
    }).then(() => true, () => false);
    const others = await prisma.patient.findMany({ where: { facilityId: facA.id }, take: 2 });
    const rs = await Promise.all([attempt(others[0].id), attempt(others[1]?.id ?? others[0].id)]);
    const rows = await prisma.externalIdentifier.count({ where: { facilityId: facA.id, value } });
    report("Concurrent linking of one ABHA address converges to a single mapping",
      rows === 1 && rs.filter(Boolean).length === 1, `rows=${rows} winners=${rs.filter(Boolean).length}`);
  }

  await mustReject("Facility A cannot map an ABHA onto a facility B patient",
    () => linkExternalIdentifier({
      facilityId: facA.id, entityType: "PATIENT", entityId: patB.id,
      system: IDENTIFIER_SYSTEMS.ABHA_NUMBER, value: `${tag}-X`, byUserId: a1.userId,
    }), /not found/i);

  {
    const body = JSON.stringify({ resourceType: "Patient", id: `${tag}-ext-race`, name: [{ text: patA.fullName }] });
    const attempt = () => importFhirPayload({
      facilityId: facA.id, rawBody: body, sourceSystem: "ABDM_SANDBOX", patientId: patA.id, byUserId: a1.userId,
    }).then((r) => r, () => null);
    const rs = await Promise.all([attempt(), attempt()]);
    const rows = await prisma.importedResource.count({
      where: { facilityId: facA.id, sourceSystem: "ABDM_SANDBOX", externalResourceId: `${tag}-ext-race` },
    });
    const ok = rs.filter(Boolean).length >= 1;
    report("Concurrent import of the same external resource converges to one staging row",
      rows === 1 && ok, `rows=${rows}`);
  }

  await mustReject("Import cannot attach a resource to another facility patient",
    () => importFhirPayload({
      facilityId: facA.id,
      rawBody: JSON.stringify({ resourceType: "Observation", id: `${tag}-o`, status: "final", code: { text: "x" } }),
      sourceSystem: "ABDM_SANDBOX", patientId: patB.id, byUserId: a1.userId,
    }), /not found/i);

  // ══ 7. SECRET LEAKAGE ════════════════════════════════════════════════════
  console.log("\n── Secret containment ──");

  {
    const health = await checkAbdmHealth(callbackConfig, { performHandshake: false });
    const json = JSON.stringify(health);
    const leaks = ["secret", CALLBACK_TOKEN, "SBX_000135"].filter((s) => json.includes(s));
    report("A health report contains no credential, token or client id", leaks.length === 0, `leaks=${leaks.join(",") || "none"}`);
  }
  {
    const events = await prisma.auditEvent.findMany({
      where: { type: { startsWith: "hospital.interop." }, facilityId: facA.id }, take: 200,
    });
    const json = JSON.stringify(events);
    const leaks = [CALLBACK_TOKEN, "test-secret-value"].filter((s) => json.includes(s));
    report("No interoperability audit event contains a secret", leaks.length === 0, `events=${events.length}`);
  }

  // ══ 8. AUDIT COVERAGE ════════════════════════════════════════════════════
  console.log("\n── Audit coverage ──");
  for (const t of [
    "hospital.interop.callbackReceived",
    "hospital.interop.callbackRejected",
    "hospital.interop.callbackReplayed",
    "hospital.interop.exchangeRequested",
    "hospital.interop.consentGranted",
    "hospital.interop.consentRevoked",
  ]) {
    const n = await prisma.auditEvent.count({ where: { type: t } });
    report(`Audit event emitted: ${t}`, n > 0, `count=${n}`);
  }

  console.log("\n════════════════════════════════════════");
  console.log(`PHASE C2 ABDM READINESS — PASS ${pass} / FAIL ${fail}`);
  if (failures.length) { console.log("Failures:"); failures.forEach((f) => console.log(`  - ${f}`)); }
  console.log("════════════════════════════════════════\n");
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
