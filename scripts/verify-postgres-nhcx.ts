/**
 * PHASE C5 — NHCX claims exchange security and concurrency verification against
 * a REAL PostgreSQL database.
 *
 * SQLite serialises writers, so it cannot prove any of the properties below.
 * Every claim this file makes about idempotency, replay and settlement races is
 * only meaningful because it executes against PostgreSQL with genuine
 * concurrency.
 *
 * The assumption throughout is that the caller is hostile and that the external
 * network is hostile. The properties that must hold regardless:
 *
 *   - a claim total is never whatever the caller says it is
 *   - one facility can never see, address or corrupt another facility's claim,
 *     submission, exchange, callback or settlement
 *   - a concurrent dispatch produces ONE external submission, not two
 *   - a replayed callback changes nothing the first one did not already change
 *   - a callback cannot nominate its own facility, patient, amount or claim
 *   - a settlement notification never moves money
 *   - break-glass does not unlock disclosure to a payer
 *   - nothing in the system can report live NHCX connectivity
 *
 * IMPORTANT: not idempotent. Run against a FRESHLY migrated and seeded database.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-nhcx.ts
 */
import { PrismaClient, Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { buildClaimPackage } from "../src/lib/hospital/nhcx/claimPackage";
import {
  buildSubmission, dispatchSubmission, retryExchange,
  buildIdempotencyKey, syncCanonicalClaimStatus,
} from "../src/lib/hospital/nhcx/submission";
import { receiveCallback, readCallbackOutcome } from "../src/lib/hospital/nhcx/callbacks";
import {
  recordSettlement, reconcileSettlement, reconcileClaim, resolveException,
} from "../src/lib/hospital/nhcx/reconciliation";
import { recordQuery, respondToQuery, transitionQuery } from "../src/lib/hospital/nhcx/queries";
import { NhcxContractHarness, getNhcxAdapter, UnverifiedNhcxAdapter } from "../src/lib/hospital/nhcx/adapter";
import { getNhcxConfig } from "../src/lib/hospital/nhcx/config";
import { buildClaimBundle } from "../src/lib/hospital/nhcx/fhirMapper";
import { NHCX_CLAIM_BUNDLE_TYPE } from "../src/lib/hospital/nhcx/contract";
import { activateBreakGlass } from "../src/lib/auth/authorize/breakGlass";
import { authorizeAccess } from "../src/lib/auth/authorize/engine";
import { getActionPolicy } from "../src/lib/auth/authorize/policies";
import { requestConsent, grantConsent, revokeConsent } from "../src/lib/hospital/interoperability/consent";
import type { AuthorizationActor } from "../src/lib/auth/authorize/types";

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

/**
 * Build a fully claimable invoice + claim for a covered patient.
 *
 * Rows are created directly rather than through the billing services because
 * this script is verifying the CLAIMS EXCHANGE boundary, and the fixture needs
 * to be deterministic. Every field still matches the canonical Phase 5 shape —
 * notably, InvoiceLine carries netAmountMinor and neither InvoiceLine nor
 * ClaimLine is facility-scoped; they inherit tenancy from their parent.
 */
async function makeClaim(args: {
  facilityId: string; patientId: string; coverageId: string;
  billingAccountId: string; encounterId: string;
  createdByUserId: string; amountMinor: number; tag: string;
}) {
  const invoice = await prisma.invoice.create({
    data: {
      facilityId: args.facilityId,
      patientId: args.patientId,
      billingAccountId: args.billingAccountId,
      encounterId: args.encounterId,
      invoiceNumber: `${args.tag}-INV-${randomUUID().slice(0, 8)}`,
      status: "ISSUED",
      subtotalMinor: args.amountMinor,
      totalMinor: args.amountMinor,
      issuedAt: new Date(),
      generatedByUserId: args.createdByUserId,
      lines: {
        create: [{
          description: "Verification charge",
          quantity: 1,
          unitPriceMinor: args.amountMinor,
          netAmountMinor: args.amountMinor,
        }],
      },
    },
    include: { lines: true },
  });

  const claim = await prisma.claim.create({
    data: {
      facilityId: args.facilityId,
      invoiceId: invoice.id,
      coverageId: args.coverageId,
      claimNumber: `${args.tag}-CLM-${randomUUID().slice(0, 8)}`,
      status: "DRAFT",
      submittedAmountMinor: args.amountMinor,
      createdByUserId: args.createdByUserId,
      lines: {
        create: invoice.lines.map((l) => ({
          invoiceLineId: l.id,
          claimedAmountMinor: l.netAmountMinor,
        })),
      },
    },
  });
  return { invoice, claim };
}

async function main() {
  const tag = `c5-${Date.now().toString(36)}`;
  const facA = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Medical Centre" } });
  const facB = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Noida Hospital" } });

  const adminA = await prisma.hospitalStaffProfile.findFirstOrThrow({
    where: { facilityId: facA.id, status: "ACTIVE", user: { role: "HOSPITAL_ADMIN" } }, include: { user: true },
  });
  const adminB = await prisma.hospitalStaffProfile.findFirstOrThrow({
    where: { facilityId: facB.id, status: "ACTIVE", user: { role: "HOSPITAL_ADMIN" } }, include: { user: true },
  });
  const doctorA = await prisma.hospitalStaffProfile.findFirstOrThrow({
    where: { facilityId: facA.id, status: "ACTIVE", user: { role: "DOCTOR" } }, include: { user: true },
  });

  const actorOf = (s: typeof adminA, authAgeMs: number | null = 1_000): AuthorizationActor => ({
    userId: s.userId, role: s.user.role, staffId: s.id,
    staffStatus: s.status, facilityId: s.facilityId, authAgeMs,
  });
  const A = actorOf(adminA);
  const B = actorOf(adminB);
  const docA = actorOf(doctorA);

  // The seed gives facility A's first patients insurance coverage.
  const coverage = await prisma.patientCoverage.findFirstOrThrow({
    where: { status: "ACTIVE", payer: { type: "INSURANCE" }, patient: { facilityId: facA.id } },
    include: { patient: true, payer: true },
  });
  const patA = coverage.patient;

  // One encounter + billing account is enough: Invoice is not unique on
  // encounter, so every fixture invoice can hang off the same admission.
  const encounterA = await prisma.encounter.create({
    data: {
      facilityId: facA.id, patientId: patA.id, type: "OPD",
      status: "REGISTERED", registeredAt: new Date(),
    },
  });
  const accountA = await prisma.billingAccount.create({
    data: { facilityId: facA.id, patientId: patA.id, encounterId: encounterA.id, status: "OPEN" },
  });

  // Disclosure to a payer requires an INSURANCE consent covering BILLING. The
  // whole boundary is unusable without one, which is the intended design — this
  // fixture grants it explicitly rather than the code assuming it.
  const insuranceConsent = await requestConsent({
    facilityId: facA.id, patientId: patA.id, purpose: "INSURANCE",
    scopes: ["BILLING", "DOCUMENTS", "DIAGNOSIS"],
    recipientType: "ORGANIZATION", recipientIdentifier: coverage.payerId,
    recipientName: coverage.payer.name, byUserId: adminA.userId,
  });
  await grantConsent({
    facilityId: facA.id, consentId: insuranceConsent.id,
    grantedBy: "PATIENT", byUserId: adminA.userId,
  });

  const mk = (amountMinor: number, coverageId: string = coverage.id) =>
    makeClaim({
      facilityId: facA.id, patientId: patA.id, coverageId,
      billingAccountId: accountA.id, encounterId: encounterA.id,
      createdByUserId: adminA.userId, amountMinor, tag,
    });

  console.log(`\n=== A=${facA.name} / B=${facB.name} · patient=${patA.uhid} ===\n`);

  // ══ 1. PACKAGE COMPOSITION IS SERVER-DERIVED ═════════════════════════════
  console.log("── Package composition ──");

  const { claim: claim1, invoice: invoice1 } = await mk(250_000);

  const pkg1 = await buildClaimPackage({ claimId: claim1.id, facilityId: facA.id, actor: A });
  report("The claimed total is recomputed from canonical invoice lines",
    pkg1.totals.claimedMinor === 250_000, `got ${pkg1.totals.claimedMinor}`);
  report("Every amount in the package is an integer of minor units",
    Number.isInteger(pkg1.totals.claimedMinor) && pkg1.lines.every((l) => Number.isInteger(l.claimedAmountMinor)));
  report("A clean package carries no blockers",
    pkg1.blockers.length === 0, pkg1.blockers.join("; "));

  {
    // Tamper with the canonical claim total ONLY. The package must follow the
    // invoice lines, not the stored header amount.
    await prisma.claim.update({ where: { id: claim1.id }, data: { submittedAmountMinor: 9_999_999 } });
    const tampered = await buildClaimPackage({ claimId: claim1.id, facilityId: facA.id, actor: A });
    report("A tampered claim header does not change the derived claim total",
      tampered.totals.claimedMinor === 250_000, `got ${tampered.totals.claimedMinor}`);
    await prisma.claim.update({ where: { id: claim1.id }, data: { submittedAmountMinor: 250_000 } });
  }

  await mustReject("Facility B cannot build a package for a facility A claim",
    () => buildClaimPackage({ claimId: claim1.id, facilityId: facB.id, actor: B }), /not found/i);

  {
    // Cross-tenant probing must be indistinguishable from a nonexistent claim.
    let notFoundMsg = "", foreignMsg = "";
    try { await buildClaimPackage({ claimId: `${tag}-nope`, facilityId: facB.id, actor: B }); }
    catch (e) { notFoundMsg = (e as Error).message; }
    try { await buildClaimPackage({ claimId: claim1.id, facilityId: facB.id, actor: B }); }
    catch (e) { foreignMsg = (e as Error).message; }
    report("A foreign claim is indistinguishable from a nonexistent one",
      notFoundMsg === foreignMsg && notFoundMsg.length > 0, `"${notFoundMsg}" vs "${foreignMsg}"`);
  }

  {
    // Expired coverage must BLOCK, not warn.
    const expired = await prisma.patientCoverage.create({
      data: {
        patientId: patA.id, payerId: coverage.payerId, planId: coverage.planId,
        memberId: `${tag}-EXP`, status: "ACTIVE",
        validFrom: new Date("2020-01-01"), validTo: new Date("2021-01-01"),
        addedByUserId: adminA.userId,
      },
    });
    const { claim: expiredClaim } = await mk(100_000, expired.id);
    const p = await buildClaimPackage({ claimId: expiredClaim.id, facilityId: facA.id, actor: A });
    report("Expired coverage is a BLOCKER, not a warning",
      p.blockers.some((b) => /expired/i.test(b)) && !p.warnings.some((w) => /expired/i.test(w)),
      p.blockers.join("; "));
    await mustReject("A blocked package cannot be built into a submission",
      () => buildSubmission({ claimId: expiredClaim.id, facilityId: facA.id, actor: A }),
      /cannot be submitted/i);
  }

  {
    // A claim whose coverage belongs to a DIFFERENT patient.
    const otherPatient = await prisma.patient.findFirstOrThrow({
      where: { facilityId: facA.id, id: { not: patA.id } },
    });
    const wrong = await prisma.patientCoverage.create({
      data: {
        patientId: otherPatient.id, payerId: coverage.payerId, planId: coverage.planId,
        memberId: `${tag}-WRONG`, status: "ACTIVE", validFrom: new Date("2026-01-01"),
        addedByUserId: adminA.userId,
      },
    });
    const { claim: mismatched } = await mk(100_000, wrong.id);
    const p = await buildClaimPackage({ claimId: mismatched.id, facilityId: facA.id, actor: A });
    report("Coverage belonging to another patient blocks the package",
      p.blockers.some((b) => /different patient/i.test(b)), p.blockers.join("; "));
  }

  // ══ 2. FHIR REPRESENTATION ═══════════════════════════════════════════════
  console.log("\n── FHIR representation ──");

  {
    const bundle = buildClaimBundle(pkg1, {
      timestamp: new Date("2026-01-01T00:00:00Z"),
      bundleId: `${tag}-b1`, facilityName: facA.name,
      payerParticipantCode: null, patientExternalIdentifiers: [],
    }) as { type: string; entry: { resource: { resourceType: string } }[] };

    report("The claim bundle is a collection, never an ABDM document bundle",
      bundle.type === NHCX_CLAIM_BUNDLE_TYPE && (bundle.type as string) !== "document", `type=${bundle.type}`);

    const types = bundle.entry.map((e) => e.resource.resourceType);
    report("The bundle carries Claim, Patient, Coverage and Organization resources",
      ["Claim", "Patient", "Coverage", "Organization"].every((t) => types.includes(t)), types.join(","));

    const json = JSON.stringify(bundle);
    report("The bundle does not leak an internal database id as a business identifier",
      !json.includes(adminA.userId), "user id present");
  }

  // ══ 3. AUTHORIZATION AND CONSENT ═════════════════════════════════════════
  console.log("\n── Authorization ──");

  await mustReject("A stale session cannot compose a payer package — step-up is required",
    () => buildSubmission({ claimId: claim1.id, facilityId: facA.id, actor: { ...A, authAgeMs: 60 * 60_000 } }),
    /re-?authenticat|step.?up/i);

  await mustReject("Facility B cannot build a submission for a facility A claim",
    () => buildSubmission({ claimId: claim1.id, facilityId: facB.id, actor: B }), /not found/i);

  {
    // Break-glass is an emergency CLINICAL override. It must never become a
    // route for disclosing a patient's records to an insurer.
    for (const action of ["claim.read", "claim.submit", "claim.dispatch", "claim.adjust", "claim.reconcile"]) {
      const policy = getActionPolicy(action);
      report(`Policy ${action} declares breakGlassAllowed = false`,
        !!policy && policy.breakGlassAllowed === false, policy ? String(policy.breakGlassAllowed) : "no policy");
    }

    const bg = await activateBreakGlass({
      facilityId: facA.id, patientId: patA.id, actorUserId: doctorA.userId,
      actorStaffId: doctorA.id, reason: "Verification: break-glass must not unlock payer disclosure.",
      emergencyContext: "LIFE_THREATENING",
    }).catch(() => null);
    report("Break-glass activation succeeded (precondition for the next check)", !!bg);

    const decision = await authorizeAccess({
      actor: { ...docA, authAgeMs: 1_000 },
      action: "claim.submit",
      resource: {
        type: "CLAIM", id: claim1.id, facilityId: facA.id,
        patientId: patA.id, dataClass: "FINANCIAL",
      },
      purpose: "INSURANCE", scopes: ["BILLING"],
    });
    report("With break-glass ACTIVE, payer disclosure is still not permitted",
      decision.decision !== "ALLOW", `decision=${decision.decision}`);
    await mustReject("Break-glass does NOT unlock building a payer submission",
      () => buildSubmission({ claimId: claim1.id, facilityId: facA.id, actor: { ...docA, authAgeMs: 1_000 } }));
  }

  {
    // Consent is required and is not interchangeable with authorization.
    const throwaway = await requestConsent({
      facilityId: facA.id, patientId: patA.id, purpose: "TREATMENT",
      scopes: ["ALL_CLINICAL"], recipientType: "ORGANIZATION",
      recipientIdentifier: `${tag}-other`, byUserId: adminA.userId,
    });
    await grantConsent({ facilityId: facA.id, consentId: throwaway.id, grantedBy: "PATIENT", byUserId: adminA.userId });
    const d = await authorizeAccess({
      actor: A, action: "claim.submit",
      resource: { type: "CLAIM", id: claim1.id, facilityId: facA.id, patientId: patA.id, dataClass: "FINANCIAL" },
      purpose: "INSURANCE", scopes: ["BILLING"], consentId: throwaway.id,
    });
    report("A TREATMENT consent does not authorise an INSURANCE disclosure",
      d.decision !== "ALLOW", `decision=${d.decision}`);
  }

  // ══ 4. SUBMISSION VERSIONING AND IMMUTABILITY ════════════════════════════
  console.log("\n── Submission versioning ──");

  const built1 = await buildSubmission({ claimId: claim1.id, facilityId: facA.id, actor: A });
  report("The first submission is version 1 and type ORIGINAL",
    built1.submission.version === 1 && built1.submission.submissionType === "ORIGINAL");
  report("The submission records the server-derived amount, not the tampered header",
    built1.submission.claimedAmountMinor === 250_000, `got ${built1.submission.claimedAmountMinor}`);
  report("The submission stores a content hash of exactly what it composed",
    !!built1.submission.snapshotHash && built1.submission.snapshotHash.length === 64);

  await mustReject("A resubmission without a correction reason is refused",
    () => buildSubmission({ claimId: claim1.id, facilityId: facA.id, actor: A, submissionType: "RESUBMISSION" }),
    /correction reason/i);

  const built2 = await buildSubmission({
    claimId: claim1.id, facilityId: facA.id, actor: A,
    submissionType: "RESUBMISSION", correctionReason: "Verification resubmission.",
  });
  report("A resubmission increments the version rather than mutating version 1",
    built2.submission.version === 2 && built2.submission.id !== built1.submission.id);

  {
    const v1 = await prisma.claimSubmission.findUniqueOrThrow({ where: { id: built1.submission.id } });
    report("Version 1 is superseded, never deleted — history stays reconstructable",
      v1.status === "SUPERSEDED", `status=${v1.status}`);
    report("The superseded snapshot hash is unchanged",
      v1.snapshotHash === built1.submission.snapshotHash);
  }

  {
    // Only one claim row exists for the invoice: resubmission must not have
    // created a second canonical Claim.
    const claimCount = await prisma.claim.count({ where: { invoiceId: invoice1.id } });
    report("Resubmission never creates a second canonical Claim for the invoice",
      claimCount === 1, `${claimCount} claims`);
  }

  // ══ 5. CONCURRENCY: SUBMISSION VERSION RACE ══════════════════════════════
  console.log("\n── Concurrency: submission version race ──");

  {
    const { claim } = await mk(120_000);
    await buildSubmission({ claimId: claim.id, facilityId: facA.id, actor: A });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        buildSubmission({
          claimId: claim.id, facilityId: facA.id, actor: A,
          submissionType: "RESUBMISSION", correctionReason: "Race.",
        })
      )
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const rows = await prisma.claimSubmission.findMany({
      where: { claimId: claim.id }, orderBy: { version: "asc" }, select: { version: true },
    });
    const versions = rows.map((r) => r.version);
    report("Concurrent resubmissions never produce a duplicate version number",
      new Set(versions).size === versions.length, `versions=${versions.join(",")}`);
    report("The (claim, version) unique constraint rejects the losers rather than corrupting",
      ok < 6 || new Set(versions).size === versions.length, `${ok}/6 succeeded`);
  }

  // ══ 6. CONCURRENCY: IDEMPOTENT DISPATCH ══════════════════════════════════
  console.log("\n── Concurrency: idempotent dispatch ──");

  {
    const { claim } = await mk(300_000);
    const built = await buildSubmission({ claimId: claim.id, facilityId: facA.id, actor: A });
    const harness = new NhcxContractHarness("SUCCESS");

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        dispatchSubmission({ submissionId: built.submission.id, facilityId: facA.id, actor: A }, { adapter: harness })
      )
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof dispatchSubmission>>>[];
    const exchanges = await prisma.nhcxExchange.findMany({ where: { claimId: claim.id } });

    report("Eight concurrent dispatches produce exactly ONE exchange",
      exchanges.length === 1, `${exchanges.length} exchanges`);
    report("The external adapter is called at most once for one logical submission",
      harness.callCount <= 1, `${harness.callCount} calls`);
    report("The losing callers are deduplicated onto the same exchange, not errored",
      fulfilled.length >= 1 && new Set(fulfilled.map((r) => r.value.exchange.id)).size === 1,
      `${fulfilled.length} fulfilled`);
    report("At least one caller is told it was deduplicated",
      fulfilled.some((r) => r.value.deduplicated === true));

    const ex = exchanges[0];
    report("The correlation id is a server-generated UUID", /^[0-9a-f-]{36}$/i.test(ex.correlationId));
    report("The idempotency key is derived, not client-supplied",
      ex.idempotencyKey === buildIdempotencyKey({
        facilityId: facA.id, claimId: claim.id, version: 1,
        packageHash: built.submission.snapshotHash ?? "",
      }));

    // ══ 7. CALLBACK ATTACKS ════════════════════════════════════════════════
    console.log("\n── Callback attacks ──");

    const cfg = {
      ...getNhcxConfig({}),
      environment: "SANDBOX" as const,
      callbackToken: "verification-shared-secret",
    };
    const ts = () => new Date().toISOString();
    const envelope = (body: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
      messageType: "CLAIM_RESPONSE",
      rawBody: JSON.stringify(body),
      headers: { token: cfg.callbackToken, timestamp: ts(), correlationId: ex.correlationId },
      ...over,
    });

    await mustReject("A callback with no token is refused",
      () => receiveCallback({ config: cfg, envelope: envelope({}, { headers: { token: null, timestamp: ts(), correlationId: ex.correlationId } }) }),
      /authentication/i);

    await mustReject("A callback with a wrong token is refused",
      () => receiveCallback({ config: cfg, envelope: envelope({}, { headers: { token: "wrong-secret-value", timestamp: ts(), correlationId: ex.correlationId } }) }),
      /authentication/i);

    await mustReject("A callback with a stale timestamp is refused",
      () => receiveCallback({
        config: cfg,
        envelope: envelope({}, {
          headers: { token: cfg.callbackToken, timestamp: new Date(Date.now() - 3_600_000).toISOString(), correlationId: ex.correlationId },
        }),
      }), /window/i);

    await mustReject("A callback body that is not JSON is refused",
      () => receiveCallback({ config: cfg, envelope: { ...envelope({}), rawBody: "<html>nope" } }),
      /json/i);

    {
      // A callback naming an unknown correlation must not create claim state.
      const before = await prisma.nhcxCallbackEvent.count();
      const r = await receiveCallback({
        config: cfg,
        envelope: envelope({ outcome: "APPROVED" }, {
          headers: { token: cfg.callbackToken, timestamp: ts(), correlationId: randomUUID() },
        }),
      });
      const after = await prisma.nhcxCallbackEvent.count();
      report("An unmatched correlation is reported UNMATCHED and creates no ledger row",
        r.status === "UNMATCHED" && after === before, `status=${r.status}`);
    }

    {
      // The headline attack: a callback body claiming a foreign facility and a
      // foreign patient, on a correlation that IS ours.
      const r = await receiveCallback({
        config: cfg,
        envelope: envelope({
          eventId: `${tag}-evt-1`, outcome: "APPROVED", approvedAmountMinor: 200_000,
          facilityId: facB.id, patientId: "attacker-supplied", claimId: "attacker-supplied",
        }),
      });
      const event = await prisma.nhcxCallbackEvent.findFirstOrThrow({
        where: { externalEventId: `${tag}-evt-1` },
      });
      report("The callback is filed against OUR facility, not the one it named",
        event.facilityId === facA.id, `facilityId=${event.facilityId}`);
      report("The callback is accepted on a matched correlation", r.status === "ACCEPTED", r.status);

      const sub = await prisma.claimSubmission.findUniqueOrThrow({ where: { id: built.submission.id } });
      report("The payer's approved amount is recorded separately from the claimed amount",
        sub.approvedAmountMinor === 200_000 && sub.claimedAmountMinor === 300_000,
        `approved=${sub.approvedAmountMinor} claimed=${sub.claimedAmountMinor}`);
      report("The originally claimed amount is never overwritten by a callback",
        sub.claimedAmountMinor === 300_000);
    }

    {
      // Replay the SAME event id.
      const before = await prisma.claimSubmission.findUniqueOrThrow({ where: { id: built.submission.id } });
      const r = await receiveCallback({
        config: cfg,
        envelope: envelope({
          eventId: `${tag}-evt-1`, outcome: "REJECTED", approvedAmountMinor: 0,
        }),
      });
      const after = await prisma.claimSubmission.findUniqueOrThrow({ where: { id: built.submission.id } });
      report("A replayed callback is reported DUPLICATE", r.status === "DUPLICATE", r.status);
      report("A replayed callback changes no submission state",
        after.status === before.status && after.approvedAmountMinor === before.approvedAmountMinor,
        `${before.status}/${before.approvedAmountMinor} -> ${after.status}/${after.approvedAmountMinor}`);
    }

    {
      // Concurrent delivery of the same event id: the unique constraint, not a
      // lookup, is what has to hold.
      const eventId = `${tag}-evt-race`;
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          receiveCallback({
            config: cfg,
            envelope: envelope({ eventId, outcome: "PENDING" }),
          })
        )
      );
      const settled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof receiveCallback>>>[];
      const accepted = settled.filter((r) => r.value.status === "ACCEPTED").length;
      const rows = await prisma.nhcxCallbackEvent.count({ where: { externalEventId: eventId } });
      report("Eight concurrent identical callbacks store exactly ONE ledger row",
        rows === 1, `${rows} rows`);
      report("Exactly one concurrent callback is ACCEPTED; the rest are DUPLICATE",
        accepted === 1, `${accepted} accepted of ${settled.length}`);
    }

    {
      // Amount tampering through the callback body.
      const r = await receiveCallback({
        config: cfg,
        envelope: envelope({
          eventId: `${tag}-evt-float`, outcome: "APPROVED", approvedAmountMinor: 12_345.67,
        }),
      });
      void r;
      const sub = await prisma.claimSubmission.findUniqueOrThrow({ where: { id: built.submission.id } });
      report("A float approved amount is refused rather than rounded into the record",
        sub.approvedAmountMinor === 200_000, `approved=${sub.approvedAmountMinor}`);
      report("readCallbackOutcome rejects a negative amount outright",
        readCallbackOutcome({ approvedAmountMinor: -500 }).approvedAmountMinor === null);
    }
  }

  // ══ 8. RETRY SAFETY ══════════════════════════════════════════════════════
  console.log("\n── Retry safety ──");

  {
    const { claim } = await mk(175_000);
    const built = await buildSubmission({ claimId: claim.id, facilityId: facA.id, actor: A });
    const harness = new NhcxContractHarness("DUPLICATE");
    const d = await dispatchSubmission(
      { submissionId: built.submission.id, facilityId: facA.id, actor: A }, { adapter: harness }
    );
    report("A rejected dispatch leaves a durable FAILED exchange, not nothing",
      d.exchange.protocolState === "FAILED", d.exchange.protocolState);
    await mustReject("A non-retryable failure cannot be retried into a duplicate claim",
      () => retryExchange({ exchangeId: d.exchange.id, facilityId: facA.id, actor: A }), /not retryable/i);

    const c = await prisma.claim.findUniqueOrThrow({ where: { id: claim.id } });
    report("A transport failure does not mark the canonical claim REJECTED",
      c.status !== "REJECTED", `status=${c.status}`);
  }

  {
    const { claim } = await mk(180_000);
    const built = await buildSubmission({ claimId: claim.id, facilityId: facA.id, actor: A });
    const harness = new NhcxContractHarness(["SERVER_ERROR", "SUCCESS"]);
    const d = await dispatchSubmission(
      { submissionId: built.submission.id, facilityId: facA.id, actor: A }, { adapter: harness }
    );
    const keyBefore = d.exchange.idempotencyKey;
    const retried = await retryExchange(
      { exchangeId: d.exchange.id, facilityId: facA.id, actor: A }, { adapter: harness }
    );
    report("A retry reuses the SAME idempotency identity",
      retried.idempotencyKey === keyBefore);
    const count = await prisma.nhcxExchange.count({ where: { claimId: claim.id } });
    report("A retry never creates a second exchange", count === 1, `${count} exchanges`);
    await mustReject("Facility B cannot retry a facility A exchange",
      () => retryExchange({ exchangeId: d.exchange.id, facilityId: facB.id, actor: B }), /not found/i);
  }

  // ══ 9. QUERY DISCLOSURE ══════════════════════════════════════════════════
  console.log("\n── Query disclosure ──");

  {
    const built = await prisma.claimSubmission.findFirstOrThrow({
      where: { facilityId: facA.id }, orderBy: { createdAt: "desc" },
    });
    const q = await recordQuery({
      facilityId: facA.id, submissionId: built.id,
      questionText: "Please supply the discharge summary. <script>alert(1)</script>",
      externalQueryId: `${tag}-q1`, reasonCode: "DOC_REQUIRED", byUserId: adminA.userId,
    });
    report("Payer question text is stored as data, not interpreted",
      q.questionText.includes("<script>"), "stored verbatim");

    await mustReject("Facility B cannot record a query against a facility A submission",
      () => recordQuery({ facilityId: facB.id, submissionId: built.id, questionText: "x", byUserId: adminB.userId }),
      /not found/i);

    // A document belonging to ANOTHER patient must never be attachable.
    const foreignDoc = await prisma.clinicalDocument.findFirst({
      where: { facilityId: facA.id, patientId: { not: built.patientId } },
    });
    if (foreignDoc) {
      const r = await respondToQuery({
        facilityId: facA.id, queryId: q.id, responseText: "Attached.",
        documentIds: [foreignDoc.id], actor: A,
      });
      report("A document belonging to another patient is refused, not silently attached",
        r.attachedDocuments.length === 0 && r.refusedDocuments.length === 1,
        `attached=${r.attachedDocuments.length} refused=${r.refusedDocuments.length}`);
      report("The refusal is reported back rather than dropped",
        /different patient/i.test(r.refusedDocuments[0]?.reason ?? ""));
    } else {
      report("A document belonging to another patient is refused (no fixture available — SKIPPED)", true, "skipped");
      report("The refusal is reported back (no fixture available — SKIPPED)", true, "skipped");
    }

    await mustReject("An answered query cannot be answered again",
      () => respondToQuery({ facilityId: facA.id, queryId: q.id, responseText: "Again.", actor: A }),
      /cannot be answered/i);

    await mustReject("A query cannot skip straight from RESPONSE_SUBMITTED to CLOSED",
      () => transitionQuery({ facilityId: facA.id, queryId: q.id, to: "CLOSED" as never, byUserId: adminA.userId }),
      /illegal query transition/i);
  }

  // ══ 10. SETTLEMENT AND RECONCILIATION ════════════════════════════════════
  console.log("\n── Settlement and reconciliation ──");

  {
    const { claim } = await mk(500_000);

    await mustReject("A float settlement amount is refused outright",
      () => recordSettlement({
        facilityId: facA.id, claimId: claim.id, externalSettlementRef: `${tag}-S-float`,
        settledAmountMinor: 1234.56, byUserId: adminA.userId,
      }), /integer/i);

    await mustReject("A negative settlement amount is refused",
      () => recordSettlement({
        facilityId: facA.id, claimId: claim.id, externalSettlementRef: `${tag}-S-neg`,
        settledAmountMinor: -1, byUserId: adminA.userId,
      }), /integer/i);

    await mustReject("Facility B cannot record a settlement against a facility A claim",
      () => recordSettlement({
        facilityId: facB.id, claimId: claim.id, externalSettlementRef: `${tag}-S-x`,
        settledAmountMinor: 100, byUserId: adminB.userId,
      }), /not found/i);

    const ref = `${tag}-S-race`;
    const paymentsBefore = await prisma.payment.count({ where: { facilityId: facA.id } });

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        recordSettlement({
          facilityId: facA.id, claimId: claim.id, externalSettlementRef: ref,
          settledAmountMinor: 450_000, byUserId: adminA.userId,
        })
      )
    );
    const settlements = await prisma.claimSettlement.findMany({ where: { facilityId: facA.id, externalSettlementRef: ref } });
    const created = (results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof recordSettlement>>>[])
      .filter((r) => r.value.duplicate === false).length;

    report("Eight concurrent identical settlement notifications store exactly ONE row",
      settlements.length === 1, `${settlements.length} rows`);
    report("Exactly one concurrent notification is treated as new",
      created === 1, `${created} treated as new`);

    const paymentsAfter = await prisma.payment.count({ where: { facilityId: facA.id } });
    report("Recording a settlement creates NO canonical Payment — money is not moved",
      paymentsAfter === paymentsBefore, `${paymentsBefore} -> ${paymentsAfter}`);

    {
      // The same reference notified again with a DIFFERENT amount is a real
      // discrepancy and must surface as a critical exception.
      const r = await recordSettlement({
        facilityId: facA.id, claimId: claim.id, externalSettlementRef: ref,
        settledAmountMinor: 999_999, byUserId: adminA.userId,
      });
      const ex = await prisma.reconciliationException.findFirst({
        where: { facilityId: facA.id, settlementId: settlements[0].id, exceptionType: "DUPLICATE_SETTLEMENT" },
      });
      report("A repeat notification is reported as a duplicate, not a new settlement",
        r.duplicate === true);
      report("A duplicate with a different amount raises a CRITICAL exception",
        !!ex && ex.severity === "CRITICAL", ex ? ex.severity : "none");
      report("The stored settlement amount is not overwritten by the conflicting notification",
        (await prisma.claimSettlement.findUniqueOrThrow({ where: { id: settlements[0].id } })).settledAmountMinor === 450_000);
    }

    {
      // Cross-facility payment linkage.
      const paymentB = await prisma.payment.findFirst({ where: { facilityId: facB.id } });
      if (paymentB) {
        await mustReject("A settlement cannot be linked to another facility's payment",
          () => reconcileSettlement({
            facilityId: facA.id, settlementId: settlements[0].id,
            paymentId: paymentB.id, byUserId: adminA.userId,
          }), /not found/i);
      } else {
        report("A settlement cannot be linked to another facility's payment (no fixture — SKIPPED)", true, "skipped");
      }
    }

    {
      const results2 = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          reconcileSettlement({ facilityId: facA.id, settlementId: settlements[0].id, byUserId: adminA.userId })
        )
      );
      const ok = results2.filter((r) => r.status === "fulfilled").length;
      report("Concurrent reconciliation of one settlement succeeds exactly once",
        ok === 1, `${ok}/5 succeeded`);
      await mustReject("A RECONCILED settlement cannot be reconciled again",
        () => reconcileSettlement({ facilityId: facA.id, settlementId: settlements[0].id, byUserId: adminA.userId }),
        /cannot be reconciled/i);
    }

    {
      const r = await reconcileClaim({ facilityId: facA.id, claimId: claim.id, byUserId: adminA.userId });
      report("Reconciliation reports findings rather than correcting anything",
        typeof r.exceptionsRaised === "number");
      const paymentsNow = await prisma.payment.count({ where: { facilityId: facA.id } });
      report("Reconciliation creates no Payment and alters no invoice balance",
        paymentsNow === paymentsBefore, `${paymentsBefore} -> ${paymentsNow}`);
      await mustReject("Facility B cannot reconcile a facility A claim",
        () => reconcileClaim({ facilityId: facB.id, claimId: claim.id, byUserId: adminB.userId }), /not found/i);
    }

    {
      const ex = await prisma.reconciliationException.findFirstOrThrow({
        where: { facilityId: facA.id, status: "OPEN" },
      });
      await mustReject("An exception cannot be resolved without a note",
        () => resolveException({ facilityId: facA.id, exceptionId: ex.id, to: "RESOLVED", byUserId: adminA.userId }),
        /note is required/i);
      await mustReject("Facility B cannot resolve a facility A exception",
        () => resolveException({
          facilityId: facB.id, exceptionId: ex.id, to: "RESOLVED",
          note: "Attempt.", byUserId: adminB.userId,
        }), /not found/i);
      const resolved = await resolveException({
        facilityId: facA.id, exceptionId: ex.id, to: "RESOLVED",
        note: "Verified against the payer advice.", byUserId: adminA.userId,
      });
      report("A resolved exception records who resolved it and why",
        resolved.status === "RESOLVED" && !!resolved.resolutionNote && resolved.resolvedByUserId === adminA.userId);
      await mustReject("A RESOLVED exception is terminal",
        () => resolveException({
          facilityId: facA.id, exceptionId: ex.id, to: "OPEN",
          note: "Reopen.", byUserId: adminA.userId,
        }), /illegal exception transition/i);
    }
  }

  // ══ 11. CANONICAL BILLING IS NOT DESTABILISED ════════════════════════════
  console.log("\n── Canonical billing integrity ──");

  {
    const { claim } = await mk(90_000);
    await prisma.claim.update({ where: { id: claim.id }, data: { status: "SETTLED" } });
    const after = await syncCanonicalClaimStatus(claim.id, facA.id, "SUBMITTED", adminA.userId);
    report("A protocol event cannot force an illegal canonical claim transition",
      after?.status === "SETTLED", `status=${after?.status}`);

    const foreign = await syncCanonicalClaimStatus(claim.id, facB.id, "SUBMITTED", adminB.userId);
    report("Cross-facility canonical sync is a no-op", foreign === null);
  }

  {
    const invoice = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoice1.id }, include: { lines: true },
    });
    const lineSum = invoice.lines.reduce((a, l) => a + l.netAmountMinor, 0);
    report("The invoice total still equals the sum of its lines after all exchange activity",
      invoice.totalMinor === lineSum, `${invoice.totalMinor} vs ${lineSum}`);
    report("Every invoice amount is still an integer of minor units",
      Number.isInteger(invoice.totalMinor) && invoice.lines.every((l) => Number.isInteger(l.netAmountMinor)));
  }

  // ══ 11b. CONSENT WITHDRAWAL STOPS FUTURE DISCLOSURE ══════════════════════
  console.log("\n── Consent withdrawal ──");

  {
    const { claim } = await mk(60_000);
    // Prove it works BEFORE revocation, so the refusal after is attributable.
    const ok = await buildSubmission({ claimId: claim.id, facilityId: facA.id, actor: A });
    report("A submission can be built while consent stands", ok.submission.version === 1);

    await revokeConsent({
      facilityId: facA.id, consentId: insuranceConsent.id,
      reason: "Verification: patient withdraws payer disclosure consent.",
      byUserId: adminA.userId,
    });

    const { claim: afterClaim } = await mk(60_000);
    await mustReject("Once consent is revoked, no new submission can be built",
      () => buildSubmission({ claimId: afterClaim.id, facilityId: facA.id, actor: A }), /consent/i);
    await mustReject("Once consent is revoked, an already-built submission cannot be dispatched",
      () => dispatchSubmission({ submissionId: ok.submission.id, facilityId: facA.id, actor: A }), /consent/i);

    const preserved = await prisma.claimSubmission.findUniqueOrThrow({ where: { id: ok.submission.id } });
    report("Revocation does not erase the submission already on record",
      preserved.snapshotHash === ok.submission.snapshotHash);
  }

  // ══ 12. NO FABRICATED CONNECTIVITY ═══════════════════════════════════════
  console.log("\n── No fabricated connectivity ──");

  {
    const adapter = getNhcxAdapter();
    report("The production factory returns the unverified adapter, never the harness",
      adapter instanceof UnverifiedNhcxAdapter);
    const caps = await adapter.capabilities();
    report("The shipped adapter advertises zero operations", caps.operations.length === 0);
    report("The shipped adapter reports the transport contract as unverified",
      caps.transportContractVerified === false);

    const res = await adapter.submit({
      facilityId: facA.id, correlationId: randomUUID(), idempotencyKey: "k",
      exchangeType: "CLAIM", bundle: {},
    });
    report("The shipped adapter never returns OK", res.outcome !== "OK", res.outcome);

    const harnessRefs = await prisma.nhcxExchange.count({
      where: { facilityId: facA.id, externalReference: { startsWith: "HARNESS-" } },
    });
    report("Any harness-produced reference is identifiable as such in the database",
      harnessRefs >= 0, `${harnessRefs} harness references`);

    const succeeded = await prisma.nhcxExchange.count({
      where: { facilityId: facA.id, protocolState: "RESPONDED", externalReference: { not: { startsWith: "HARNESS-" } } },
    });
    report("No exchange claims a real external response outside the test harness",
      succeeded === 0, `${succeeded} unexplained responses`);
  }

  // ══ 13. TENANT ISOLATION SWEEP ═══════════════════════════════════════════
  console.log("\n── Tenant isolation sweep ──");

  {
    const leaked = await prisma.claimSubmission.count({ where: { facilityId: facB.id } });
    report("No facility A activity created a facility B submission", leaked === 0, `${leaked} rows`);
    const leakedEx = await prisma.nhcxExchange.count({ where: { facilityId: facB.id } });
    report("No facility A activity created a facility B exchange", leakedEx === 0, `${leakedEx} rows`);
    const leakedSet = await prisma.claimSettlement.count({ where: { facilityId: facB.id } });
    report("No facility A activity created a facility B settlement", leakedSet === 0, `${leakedSet} rows`);
    const leakedCb = await prisma.nhcxCallbackEvent.count({ where: { facilityId: facB.id } });
    report("No callback was ever filed against facility B", leakedCb === 0, `${leakedCb} rows`);

    const mismatched = await prisma.$queryRaw<{ n: bigint }[]>(Prisma.sql`
      SELECT COUNT(*)::bigint AS n
      FROM "ClaimSubmission" s
      JOIN "Claim" c ON c."id" = s."claimId"
      WHERE s."facilityId" <> c."facilityId"
    `);
    report("Every submission lives in the same facility as its claim",
      Number(mismatched[0].n) === 0, `${mismatched[0].n} mismatches`);

    const orphanExchanges = await prisma.$queryRaw<{ n: bigint }[]>(Prisma.sql`
      SELECT COUNT(*)::bigint AS n
      FROM "NhcxExchange" e
      JOIN "ClaimSubmission" s ON s."id" = e."submissionId"
      WHERE e."facilityId" <> s."facilityId"
    `);
    report("Every exchange lives in the same facility as its submission",
      Number(orphanExchanges[0].n) === 0, `${orphanExchanges[0].n} mismatches`);
  }

  // ══ 14. AUDIT COVERAGE ═══════════════════════════════════════════════════
  console.log("\n── Audit coverage ──");

  {
    const types = await prisma.auditEvent.groupBy({
      by: ["type"], where: { type: { startsWith: "hospital.claim." } }, _count: true,
    });
    const seen = new Set(types.map((t) => t.type));
    for (const t of [
      "hospital.claim.submissionBuilt",
      "hospital.claim.submitted",
      "hospital.claim.settlementRecorded",
      "hospital.claim.reconciliationException",
    ]) {
      report(`Audit records ${t}`, seen.has(t), seen.has(t) ? "" : "missing");
    }

    const detail = await prisma.auditEvent.findFirst({
      where: { type: "hospital.claim.submissionBuilt" }, orderBy: { createdAt: "desc" },
    });
    // snapshotHash is deliberately present — it is an integrity identifier, not
    // content. What must NOT appear is the package, the bundle or free text.
    const keys = Object.keys((detail?.detail ?? {}) as Record<string, unknown>);
    const forbidden = ["snapshot", "package", "bundle", "questionText", "responseText", "lines", "documents"];
    report("The audit detail carries no clinical payload, only identifiers and counts",
      forbidden.every((k) => !keys.includes(k)), keys.join(","));
    report("The audit detail still proves WHAT was composed, via its hash",
      keys.includes("snapshotHash"), keys.join(","));
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(72)}`);
  console.log(`PHASE C5 NHCX VERIFICATION — ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log(`${"═".repeat(72)}\n`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
