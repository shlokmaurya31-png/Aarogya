/**
 * PHASE C3 — ABDM integration security and concurrency verification against a
 * REAL PostgreSQL database.
 *
 * C2 attacked the callback boundary. This attacks the PROTOCOL layer C3 added:
 * the ABDM protocol state machine, correlation persistence, callback-driven
 * state transitions, and the interaction between protocol state and the local
 * exchange lifecycle.
 *
 * The central property under test: an external system (or anyone who can reach
 * the public callback URL) must never be able to drive Aarogya into a state
 * that discloses data, resurrects a refusal, or contradicts the patient.
 *
 * IMPORTANT: not idempotent. Run against a FRESHLY migrated and seeded database.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-abdm-integration.ts
 */
import { PrismaClient } from "@prisma/client";
import { getAbdmConfig, ABDM_ENV_VARS } from "../src/lib/hospital/interoperability/abdm/config";
import { receiveCallback } from "../src/lib/hospital/interoperability/abdm/callbacks";
import { recordProtocolTransition } from "../src/lib/hospital/interoperability/abdm/client";
import { isProtocolTransitionAllowed, protocolPermitsDataFetch } from "../src/lib/hospital/interoperability/abdm/protocolState";
import { createExchange, authorizeExchange, dispatchExchange } from "../src/lib/hospital/interoperability/exchange";
import { StubExchangeAdapter } from "../src/lib/hospital/interoperability/adapters/abdm";
import { requestConsent, grantConsent, revokeConsent } from "../src/lib/hospital/interoperability/consent";
import { resetRateLimiter } from "../src/lib/hospital/interoperability/abdm/rateLimit";

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

const CALLBACK_TOKEN = "c3-callback-secret";
const config = getAbdmConfig({
  [ABDM_ENV_VARS.environment]: "SANDBOX",
  [ABDM_ENV_VARS.clientId]: "SBX_000135",
  [ABDM_ENV_VARS.clientSecret]: "secret",
  [ABDM_ENV_VARS.callbackBaseUrl]: "https://aarogya.example",
  [ABDM_ENV_VARS.callbackToken]: CALLBACK_TOKEN,
});

function consentCallback(requestId: string, status: string, consentId?: string) {
  return {
    kind: "consentRequestNotify" as const,
    rawBody: JSON.stringify({
      response: { requestId },
      notification: { status, consentDetail: { consentId: consentId ?? `cm-${requestId}` } },
    }),
    headers: {
      token: CALLBACK_TOKEN,
      requestId,
      timestamp: new Date().toISOString(),
      hiuId: "SBX_000135",
    },
    sourceAddress: "203.0.113.7",
  };
}

async function main() {
  const tag = `c3-${Date.now()}`;
  resetRateLimiter();

  const facA = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Medical Centre" } });
  const facB = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Noida Hospital" } });
  const a1 = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { facilityId: facA.id, status: "ACTIVE" } });
  const patA = await prisma.patient.findFirstOrThrow({ where: { facilityId: facA.id } });

  console.log(`\n=== A=${facA.name} / B=${facB.name} ===\n`);

  /** Build a granted consent + authorized exchange with a known correlation id. */
  async function makeExchange(suffix: string) {
    const c = await requestConsent({
      facilityId: facA.id, patientId: patA.id, purpose: "TREATMENT", scopes: ["ALL_CLINICAL"],
      recipientType: "FACILITY", recipientIdentifier: `partner-${suffix}`,
      expiresAt: new Date(Date.now() + 30 * 86400_000), byUserId: a1.userId,
    });
    await grantConsent({ facilityId: facA.id, consentId: c.id, grantedBy: "PATIENT", byUserId: a1.userId });
    const correlationId = `${tag}-${suffix}`;
    const { exchange } = await createExchange({
      facilityId: facA.id, patientId: patA.id, direction: "OUTBOUND", purpose: "TREATMENT",
      scopes: ["LAB"], destinationSystem: "ABDM", consentId: c.id,
      correlationId, idempotencyKey: `${tag}-idem-${suffix}`, byUserId: a1.userId,
    });
    return { consent: c, exchange, correlationId };
  }

  // ══ 1. PROTOCOL STATE IS SEPARATE FROM LOCAL STATE ═══════════════════════
  console.log("── Protocol state separation ──");

  {
    const { exchange } = await makeExchange("sep");
    const fresh = await prisma.healthInformationExchange.findUniqueOrThrow({ where: { id: exchange.id } });
    report("A new exchange has no ABDM protocol state (nothing was sent)",
      fresh.abdmProtocolState === null, `protocol=${fresh.abdmProtocolState}`);

    await authorizeExchange({ facilityId: facA.id, exchangeId: exchange.id, byUserId: a1.userId });
    const authorized = await prisma.healthInformationExchange.findUniqueOrThrow({ where: { id: exchange.id } });
    // The distinction C3 exists to preserve: locally approved, never submitted.
    report("Local AUTHORIZED does not imply anything was sent to ABDM",
      authorized.status === "AUTHORIZED" && authorized.abdmProtocolState === null,
      `status=${authorized.status} protocol=${authorized.abdmProtocolState}`);
  }

  // ══ 2. PROTOCOL TRANSITION GUARDS ════════════════════════════════════════
  console.log("\n── Protocol transition guards ──");

  {
    const { exchange } = await makeExchange("trans");
    await mustReject("Cannot jump straight to GRANTED without submitting",
      () => recordProtocolTransition({
        exchangeId: exchange.id, facilityId: facA.id, to: "GRANTED", byUserId: a1.userId,
      }), /Illegal ABDM protocol transition/i);

    await recordProtocolTransition({
      exchangeId: exchange.id, facilityId: facA.id, to: "SUBMITTED",
      correlationId: `${tag}-trans-corr`, byUserId: a1.userId,
    });
    const submitted = await prisma.healthInformationExchange.findUniqueOrThrow({ where: { id: exchange.id } });
    report("Submission persists the correlation id server-side",
      submitted.abdmProtocolState === "SUBMITTED" && submitted.correlationId === `${tag}-trans-corr`
        && submitted.externalRequestId === `${tag}-trans-corr`);

    await mustReject("Facility B cannot move facility A protocol state",
      () => recordProtocolTransition({
        exchangeId: exchange.id, facilityId: facB.id, to: "ACKNOWLEDGED", byUserId: a1.userId,
      }), /not found/i);
  }

  // ══ 3. CALLBACK-DRIVEN PROTOCOL STATE ════════════════════════════════════
  console.log("\n── Callback-driven protocol state ──");

  {
    const { exchange, correlationId } = await makeExchange("cb");
    await recordProtocolTransition({
      exchangeId: exchange.id, facilityId: facA.id, to: "SUBMITTED", correlationId, byUserId: a1.userId,
    });

    const granted = await receiveCallback({
      config, facilityId: facA.id, envelope: consentCallback(correlationId, "GRANTED", "cm-consent-cb"),
    });
    report("A GRANTED callback advances the protocol state and records the CM consent id",
      granted.status === "ACCEPTED" && granted.protocolState === "GRANTED", `protocol=${granted.protocolState}`);

    const row = await prisma.healthInformationExchange.findUniqueOrThrow({ where: { id: exchange.id } });
    report("The consent-manager consent id is stored separately from the local consent id",
      row.abdmConsentId === "cm-consent-cb" && row.abdmConsentId !== row.consentId);
    report("Only a GRANTED artefact permits a data fetch",
      protocolPermitsDataFetch(row.abdmProtocolState) === true);
  }

  {
    // The attack that matters: a patient refused, then a later callback claims
    // otherwise. The refusal must stand.
    const { exchange, correlationId } = await makeExchange("denied");
    await recordProtocolTransition({
      exchangeId: exchange.id, facilityId: facA.id, to: "SUBMITTED", correlationId, byUserId: a1.userId,
    });
    const denied = await receiveCallback({
      config, facilityId: facA.id, envelope: consentCallback(correlationId, "DENIED"),
    });
    report("A DENIED callback is applied", denied.protocolState === "DENIED");

    // Same correlation id replayed with GRANTED — must be refused twice over:
    // by the replay ledger, and by the protocol state machine.
    const forged = await receiveCallback({
      config, facilityId: facA.id, envelope: consentCallback(correlationId, "GRANTED"),
    });
    const after = await prisma.healthInformationExchange.findUniqueOrThrow({ where: { id: exchange.id } });
    report("A later GRANTED callback cannot overturn the patient's refusal",
      after.abdmProtocolState === "DENIED", `status=${forged.status} protocol=${after.abdmProtocolState}`);
    report("A refused artefact never permits a data fetch",
      protocolPermitsDataFetch(after.abdmProtocolState) === false);
  }

  {
    const { exchange, correlationId } = await makeExchange("unknown");
    await recordProtocolTransition({
      exchangeId: exchange.id, facilityId: facA.id, to: "SUBMITTED", correlationId, byUserId: a1.userId,
    });
    await receiveCallback({
      config, facilityId: facA.id, envelope: consentCallback(correlationId, "SOMETHING_THE_SPEC_DID_NOT_DEFINE"),
    });
    const row = await prisma.healthInformationExchange.findUniqueOrThrow({ where: { id: exchange.id } });
    report("An unrecognised external status is NOT applied to protocol state",
      row.abdmProtocolState === "SUBMITTED", `protocol=${row.abdmProtocolState}`);
  }

  {
    const { exchange, correlationId } = await makeExchange("xfac");
    await recordProtocolTransition({
      exchangeId: exchange.id, facilityId: facA.id, to: "SUBMITTED", correlationId, byUserId: a1.userId,
    });
    const crossed = await receiveCallback({
      config, facilityId: facB.id, envelope: consentCallback(correlationId, "GRANTED"),
    });
    const row = await prisma.healthInformationExchange.findUniqueOrThrow({ where: { id: exchange.id } });
    report("A callback delivered under the wrong facility cannot touch the exchange",
      crossed.status === "UNMATCHED" && row.abdmProtocolState === "SUBMITTED",
      `status=${crossed.status} protocol=${row.abdmProtocolState}`);
  }

  // ══ 4. CONCURRENT CALLBACK DELIVERY ══════════════════════════════════════
  console.log("\n── Concurrency ──");

  {
    const { exchange, correlationId } = await makeExchange("race");
    await recordProtocolTransition({
      exchangeId: exchange.id, facilityId: facA.id, to: "SUBMITTED", correlationId, byUserId: a1.userId,
    });
    const attempt = () => receiveCallback({
      config, facilityId: facA.id, envelope: consentCallback(correlationId, "GRANTED"),
    }).then((r) => r.status, () => "ERROR");
    const results = await Promise.all([attempt(), attempt(), attempt(), attempt()]);
    const accepted = results.filter((r) => r === "ACCEPTED").length;
    const rows = await prisma.abdmCallbackEvent.count({
      where: { facilityId: facA.id, externalRequestId: correlationId },
    });
    report("Four concurrent identical callbacks yield exactly one accepted ledger row",
      accepted === 1 && rows === 1, `accepted=${accepted} rows=${rows}`);
  }

  {
    // Two different outcomes racing. Whichever wins, the result must be ONE
    // coherent terminal state, never an interleaved mixture.
    const { exchange, correlationId } = await makeExchange("conflict");
    await recordProtocolTransition({
      exchangeId: exchange.id, facilityId: facA.id, to: "SUBMITTED", correlationId, byUserId: a1.userId,
    });
    const g = receiveCallback({ config, facilityId: facA.id, envelope: consentCallback(correlationId, "GRANTED") })
      .then((r) => r.status, () => "ERROR");
    const d = receiveCallback({ config, facilityId: facA.id, envelope: consentCallback(correlationId, "DENIED") })
      .then((r) => r.status, () => "ERROR");
    const [r1, r2] = await Promise.all([g, d]);
    const row = await prisma.healthInformationExchange.findUniqueOrThrow({ where: { id: exchange.id } });
    report("Conflicting concurrent callbacks resolve to one coherent state",
      ["GRANTED", "DENIED"].includes(row.abdmProtocolState ?? "") &&
      [r1, r2].filter((r) => r === "ACCEPTED").length === 1,
      `protocol=${row.abdmProtocolState} results=${r1},${r2}`);
  }

  {
    const { exchange } = await makeExchange("ptrace");
    const attempt = () => recordProtocolTransition({
      exchangeId: exchange.id, facilityId: facA.id, to: "SUBMITTED",
      correlationId: `${tag}-ptrace`, byUserId: a1.userId,
    }).then(() => true, () => false);
    const rs = await Promise.all([attempt(), attempt(), attempt()]);
    const row = await prisma.healthInformationExchange.findUniqueOrThrow({ where: { id: exchange.id } });
    report("Concurrent protocol transitions converge to a single valid state",
      row.abdmProtocolState === "SUBMITTED" && rs.some(Boolean), `winners=${rs.filter(Boolean).length}`);
  }

  // ══ 5. CONSENT REVOCATION STILL DOMINATES ════════════════════════════════
  console.log("\n── Consent revocation dominance ──");

  {
    // Even with the ABDM protocol saying GRANTED, a locally revoked consent
    // must stop the transfer. The protocol is not an authorization source.
    const { consent, exchange, correlationId } = await makeExchange("revoke");
    await authorizeExchange({ facilityId: facA.id, exchangeId: exchange.id, byUserId: a1.userId });
    await recordProtocolTransition({
      exchangeId: exchange.id, facilityId: facA.id, to: "SUBMITTED", correlationId, byUserId: a1.userId,
    });
    await receiveCallback({ config, facilityId: facA.id, envelope: consentCallback(correlationId, "GRANTED") });
    await revokeConsent({ facilityId: facA.id, consentId: consent.id, reason: "withdrawn", byUserId: a1.userId });

    const dispatched = await dispatchExchange(
      { facilityId: facA.id, exchangeId: exchange.id, byUserId: a1.userId },
      { adapter: new StubExchangeAdapter() }
    );
    const provenance = await prisma.interopProvenance.count({
      where: { exchangeId: exchange.id, direction: "OUTBOUND" },
    });
    report("A revoked local consent blocks dispatch even when ABDM says GRANTED",
      dispatched.status === "FAILED" && provenance === 0 && dispatched.bundleHash === null,
      `status=${dispatched.status} provenance=${provenance}`);
    report("The blocked dispatch never entered PROCESSING",
      dispatched.processingStartedAt === null);
    const row = await prisma.healthInformationExchange.findUniqueOrThrow({ where: { id: exchange.id } });
    report("The ABDM protocol state is preserved for the audit trail",
      row.abdmProtocolState === "GRANTED", `protocol=${row.abdmProtocolState}`);
  }

  // ══ 6. STATE MACHINE INVARIANTS IN THE DATABASE ══════════════════════════
  console.log("\n── Database invariants ──");

  {
    const all = await prisma.healthInformationExchange.findMany({
      where: { facilityId: facA.id, abdmProtocolState: { not: null } }, take: 500,
    });
    report("Every persisted protocol state is a declared state",
      all.every((e) => isProtocolTransitionAllowed(e.abdmProtocolState, e.abdmProtocolState!) ||
        ["NOT_SUBMITTED", "SUBMITTED", "ACKNOWLEDGED", "GRANTED", "DENIED", "EXPIRED", "REVOKED", "ERRORED"]
          .includes(e.abdmProtocolState!)),
      `rows=${all.length}`);
    report("No exchange claims a CM consent id without having been submitted",
      all.every((e) => !e.abdmConsentId || e.abdmProtocolState !== "NOT_SUBMITTED"));

    const leaked = await prisma.auditEvent.count({
      where: { type: { startsWith: "hospital.interop.abdm" }, detail: { not: undefined } },
    });
    const events = await prisma.auditEvent.findMany({
      where: { type: { startsWith: "hospital.interop." }, facilityId: facA.id }, take: 300,
    });
    const json = JSON.stringify(events);
    report("No ABDM audit event contains the callback token or client secret",
      !json.includes(CALLBACK_TOKEN) && !json.includes("secret"), `events=${events.length} audited=${leaked}`);
  }

  // ══ 7. AUDIT COVERAGE ════════════════════════════════════════════════════
  console.log("\n── Audit coverage ──");
  for (const t of [
    "hospital.interop.abdmProtocolStateChanged",
    "hospital.interop.abdmCallbackApplied",
    "hospital.interop.callbackReceived",
    "hospital.interop.callbackReplayed",
  ]) {
    const n = await prisma.auditEvent.count({ where: { type: t } });
    report(`Audit event emitted: ${t}`, n > 0, `count=${n}`);
  }

  console.log("\n════════════════════════════════════════");
  console.log(`PHASE C3 ABDM INTEGRATION — PASS ${pass} / FAIL ${fail}`);
  if (failures.length) { console.log("Failures:"); failures.forEach((f) => console.log(`  - ${f}`)); }
  console.log("════════════════════════════════════════\n");
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
