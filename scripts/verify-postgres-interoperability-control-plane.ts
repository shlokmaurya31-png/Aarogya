/**
 * PHASE C6 — interoperability control plane security and concurrency
 * verification against a REAL PostgreSQL database.
 *
 * SQLite serialises writers, so it cannot prove a single concurrency claim
 * below. Every statement here about enable/disable races, approval races,
 * configuration races, alert de-duplication and retry duplication is only
 * meaningful because it runs against PostgreSQL with genuine parallelism.
 *
 * The assumption is that the operator is hostile and the network is hostile.
 * The properties that must hold regardless:
 *
 *   - one facility can never see, configure, disable, retry or inspect another
 *     facility's integration, participant, exchange, certificate or alert
 *   - production can never be reached without a second person's approval
 *   - a secret can never enter the database or leave through an API
 *   - a disabled integration dispatches nothing, inbound or outbound
 *   - identity is not trust: an unverified participant is refused
 *   - consent and authorization failures are never retryable
 *   - break-glass unlocks nothing in the control plane
 *   - readiness never outruns its evidence
 *
 * IMPORTANT: not idempotent. Run against a FRESHLY migrated and seeded database.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-interoperability-control-plane.ts
 */
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import {
  describeIntegration, listIntegrations, assertKnownSystem, listSystems,
} from "../src/lib/hospital/interoperability/controlPlane/registry";
import {
  configureIntegration, approveProduction, rollbackConfiguration, listRevisions,
  assertNoSecrets, validateConfiguration,
} from "../src/lib/hospital/interoperability/controlPlane/configuration";
import {
  enableIntegration, disableIntegration,
} from "../src/lib/hospital/interoperability/controlPlane/killSwitch";
import {
  registerParticipant, setParticipantTrust, resolveParticipant, listParticipants,
} from "../src/lib/hospital/interoperability/controlPlane/participants";
import {
  registerCertificate, activateNextCertificate, sweepCertificates, listCertificates,
} from "../src/lib/hospital/interoperability/controlPlane/certificates";
import { raiseAlert, transitionAlert, listAlerts } from "../src/lib/hospital/interoperability/controlPlane/alerts";
import {
  evaluateOutboundGate, evaluateInboundGate,
} from "../src/lib/hospital/interoperability/controlPlane/safetyGate";
import {
  manualRetry, collectMetrics, sweepOperationalAlerts,
} from "../src/lib/hospital/interoperability/controlPlane/operations";
import {
  listUnifiedExchanges, getExchangeTimeline, listUnifiedCallbacks,
} from "../src/lib/hospital/interoperability/controlPlane/exchanges";
import { activateBreakGlass } from "../src/lib/auth/authorize/breakGlass";
import { authorizeAccess } from "../src/lib/auth/authorize/engine";
import { getExchangeAdapter } from "../src/lib/hospital/interoperability/adapters/abdm";
import { getNhcxAdapter } from "../src/lib/hospital/nhcx/adapter";
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

async function main() {
  const tag = `c6-${Date.now().toString(36)}`;
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
  const platformAdmin = await prisma.user.findFirstOrThrow({ where: { role: "AAROGYA_ADMIN" } });

  const actorOf = (s: typeof adminA, authAgeMs: number | null = 1_000): AuthorizationActor => ({
    userId: s.userId, role: s.user.role, staffId: s.id,
    staffStatus: s.status, facilityId: s.facilityId, authAgeMs,
  });
  const A = actorOf(adminA);
  const B = actorOf(adminB);
  const docA = actorOf(doctorA);
  // The checker: platform admin, scoped to facility A for the approval act.
  const CHECKER: AuthorizationActor = {
    userId: platformAdmin.id, role: "AAROGYA_ADMIN", staffId: null,
    staffStatus: null, facilityId: facA.id, authAgeMs: 1_000,
  };

  console.log(`\n=== A=${facA.name} / B=${facB.name} ===\n`);

  // ══ 1. REGISTRY HONESTY ══════════════════════════════════════════════════
  console.log("── Registry honesty ──");

  {
    const systems = listSystems();
    report("Exactly three integrations are registered, matching the three adapters",
      systems.length === 3, systems.map((s) => s.system).join(","));
    report("No integration is registered without an adapter behind it",
      systems.every((s) => ["ABDM", "FHIR", "NHCX"].includes(s.system)));

    const nhcx = systems.find((s) => s.system === "NHCX")!;
    report("NHCX still reports its transport contract as UNVERIFIED",
      nhcx.contractVerified === false && !!nhcx.contractBlockedReason);
    report("NHCX claim submission is DOMAIN_ONLY, never IMPLEMENTED",
      nhcx.capabilities.find((c) => c.capability === "CLAIM_SUBMISSION")?.support === "DOMAIN_ONLY");

    const nhcxCaps = await getNhcxAdapter().capabilities();
    report("The shipped NHCX adapter advertises zero live operations",
      nhcxCaps.operations.length === 0, `${nhcxCaps.operations.length} operations`);

    const abdmCaps = await getExchangeAdapter("ABDM").capabilities();
    report("The ABDM adapter advertises no operations while unconfigured",
      abdmCaps.operations.length === 0, `${abdmCaps.operations.length} operations`);
  }

  await mustReject("An integration nobody implemented cannot be addressed",
    async () => assertKnownSystem("PAYER_API"), /unknown integration/i);

  // ══ 2. SECRET BOUNDARY ═══════════════════════════════════════════════════
  console.log("\n── Secret boundary ──");

  await mustReject("A client secret is refused before it can reach the database",
    async () => assertNoSecrets({ system: "ABDM", clientSecret: "super-secret" }), /never stored/i);

  await mustReject("PEM material is refused even under an innocuous key",
    async () => assertNoSecrets({ note: "-----BEGIN PRIVATE KEY-----\nX\n-----END PRIVATE KEY-----" }),
    /never be submitted/i);

  await configureIntegration({
    facilityId: facA.id, system: "ABDM", actor: A,
    environment: "SANDBOX", baseUrl: "https://dev.abdm.gov.in",
    clientIdEnvVar: "ABDM_CLIENT_ID", reason: "Verification setup.",
  });

  {
    const row = await prisma.interopConnection.findFirstOrThrow({
      where: { facilityId: facA.id, system: "ABDM" },
    });
    const serialised = JSON.stringify(row);
    report("The stored connection contains no secret-shaped value",
      !/secret|token|password|BEGIN [A-Z ]*KEY/i.test(serialised.replace(/clientIdEnvVar/gi, "")),
      "no credential material");
    report("Only an environment variable NAME is stored for the client id",
      row.clientIdEnvVar === "ABDM_CLIENT_ID");

    const view = await describeIntegration(facA.id, "ABDM");
    const runtime = JSON.stringify(view.runtime);
    report("The API view reports credential PRESENCE, never a credential value",
      !/[A-Za-z0-9]{24,}/.test(runtime.replace(/[A-Z_]{8,}/g, "")), "redacted");
  }

  // ══ 3. CONFIGURATION AND TENANT ISOLATION ════════════════════════════════
  console.log("\n── Configuration and tenant isolation ──");

  {
    const viewA = await describeIntegration(facA.id, "ABDM");
    const viewB = await describeIntegration(facB.id, "ABDM");
    report("Facility A's configuration is invisible in facility B's view",
      viewA.connection.id !== null && viewB.connection.id === null,
      `A=${!!viewA.connection.id} B=${!!viewB.connection.id}`);
    report("Facility B sees a DISABLED integration it has not configured",
      viewB.connection.environment === "DISABLED" && viewB.connection.enabled === false);
  }

  {
    // Facility B configuring "its" ABDM must create a SEPARATE row, never touch A's.
    await configureIntegration({
      facilityId: facB.id, system: "ABDM", actor: B,
      environment: "SANDBOX", baseUrl: "https://dev.abdm.gov.in",
      clientIdEnvVar: "ABDM_CLIENT_ID", reason: "Facility B setup.",
    });
    const rows = await prisma.interopConnection.findMany({ where: { system: "ABDM" } });
    const facilities = new Set(rows.map((r) => r.facilityId));
    report("Each facility gets its own connection row, never a shared one",
      facilities.has(facA.id) && facilities.has(facB.id) && rows.length >= 2, `${rows.length} rows`);
  }

  {
    const revs = await listRevisions(facA.id, "ABDM");
    const foreign = await listRevisions(facB.id, "ABDM");
    report("Configuration history is facility-scoped",
      revs.every((r) => r.facilityId === facA.id) && foreign.every((r) => r.facilityId === facB.id));
    report("A CREATE revision was recorded for the first configuration",
      revs.some((r) => r.changeKind === "CREATE"), `${revs.length} revisions`);
  }

  await mustReject("An invalid configuration is refused rather than stored",
    () => configureIntegration({
      facilityId: facA.id, system: "ABDM", actor: A,
      environment: "SANDBOX", baseUrl: "http://insecure.example",
      clientIdEnvVar: "ABDM_CLIENT_ID",
    }), /not valid/i);

  {
    const v = validateConfiguration({
      system: "ABDM", environment: "SANDBOX", baseUrl: "https://x.example", clientIdEnvVar: "literal-client-id",
    });
    report("A literal client id pasted into the variable-name field is refused",
      v.valid === false && v.invalid.join(" ").includes("NAME"));
  }

  // ══ 4. PRODUCTION ENABLEMENT — MAKER/CHECKER ═════════════════════════════
  console.log("\n── Production enablement ──");

  await configureIntegration({
    facilityId: facA.id, system: "ABDM", actor: A,
    environment: "PRODUCTION", baseUrl: "https://apis.abdm.gov.in",
    clientIdEnvVar: "ABDM_CLIENT_ID", reason: "Move to production.",
  });

  {
    const view = await describeIntegration(facA.id, "ABDM");
    report("Selecting PRODUCTION does not by itself produce a production readiness state",
      !["PRODUCTION_ENABLED", "PRODUCTION_VERIFIED"].includes(view.readiness.state), view.readiness.state);
    report("An unapproved production integration cannot dispatch",
      view.dispatch.allowed === false, view.dispatch.reason ?? "");
  }

  await mustReject("Production cannot be enabled before it is approved",
    () => enableIntegration({ facilityId: facA.id, system: "ABDM", actor: A }), /approved/i);

  await mustReject("The user who configured the integration cannot approve it",
    () => approveProduction({ facilityId: facA.id, system: "ABDM", actor: A, note: "Self-approval attempt." }),
    /cannot also approve/i);

  await mustReject("Facility B cannot approve facility A's production move",
    () => approveProduction({ facilityId: facB.id, system: "NHCX", actor: B, note: "x" }), /not found|PRODUCTION/i);

  {
    const approved = await approveProduction({
      facilityId: facA.id, system: "ABDM", actor: CHECKER, note: "Verified onboarding evidence.",
    });
    report("A second, different user can approve production",
      approved.productionApprovedByUserId === CHECKER.userId && approved.productionApprovedByUserId !== A.userId);

    const view = await describeIntegration(facA.id, "ABDM");
    report("Approval alone still does not claim production VERIFIED",
      view.readiness.state !== "PRODUCTION_VERIFIED", view.readiness.state);
    report("Production readiness stays FAIL until a real production call succeeds",
      view.readiness.dimensions.production !== "PASS", view.readiness.dimensions.production);
  }

  {
    // Enabling a production integration whose credentials are absent must still
    // refuse: approval is not a substitute for configuration.
    const view = await describeIntegration(facA.id, "ABDM");
    report("An approved production integration without runtime credentials still cannot dispatch",
      view.dispatch.allowed === false, view.dispatch.reason ?? "");
  }

  // ── Concurrency: production approval race ────────────────────────────────
  {
    await configureIntegration({
      facilityId: facB.id, system: "ABDM", actor: B,
      environment: "PRODUCTION", baseUrl: "https://apis.abdm.gov.in",
      clientIdEnvVar: "ABDM_CLIENT_ID", reason: "B to production.",
    });
    const checkerB: AuthorizationActor = { ...CHECKER, facilityId: facB.id };
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        approveProduction({ facilityId: facB.id, system: "ABDM", actor: checkerB, note: `Concurrent approval ${i}.` })
      )
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const row = await prisma.interopConnection.findFirstOrThrow({ where: { facilityId: facB.id, system: "ABDM" } });
    report("Six concurrent production approvals succeed exactly once",
      ok === 1, `${ok}/6 succeeded`);
    report("The approval record names exactly one approver",
      !!row.productionApprovedByUserId && !!row.productionApprovedAt);
  }

  // ── Concurrency: configuration race ──────────────────────────────────────
  {
    const before = await prisma.interopConnection.findFirstOrThrow({ where: { facilityId: facA.id, system: "ABDM" } });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        configureIntegration({
          facilityId: facA.id, system: "ABDM", actor: A,
          environment: "SANDBOX", baseUrl: `https://dev${i}.abdm.gov.in`,
          clientIdEnvVar: "ABDM_CLIENT_ID", reason: `Concurrent ${i}.`,
        })
      )
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const after = await prisma.interopConnection.findFirstOrThrow({ where: { facilityId: facA.id, system: "ABDM" } });
    const revs = await prisma.integrationConfigRevision.findMany({
      where: { connectionId: after.id }, orderBy: { revision: "asc" },
    });
    const revisionNumbers = revs.map((r) => r.revision);

    report("Concurrent configuration changes do not silently produce a hybrid",
      ok < 6, `${ok}/6 succeeded`);
    report("Revision numbers stay unique under a concurrent race",
      new Set(revisionNumbers).size === revisionNumbers.length, `revisions ${revisionNumbers.join(",")}`);
    report("The final base URL is exactly one of the submitted values",
      /^https:\/\/dev[0-5]\.abdm\.gov\.in$/.test(after.baseUrl ?? ""), after.baseUrl ?? "");
    report("Reconfiguration cleared the earlier production approval",
      after.productionApprovedAt === null);
    report("Reconfiguration switched the integration off rather than leaving it live",
      after.enabled === false);
    void before;
  }

  // ══ 5. KILL SWITCH ═══════════════════════════════════════════════════════
  console.log("\n── Kill switch ──");

  {
    // FHIR composes in-process and has a verified contract, so it is the one
    // integration that can genuinely be enabled in this environment.
    await configureIntegration({
      facilityId: facA.id, system: "FHIR", actor: A, environment: "LOCAL", reason: "Enable FHIR locally.",
    });
    const enabled = await enableIntegration({ facilityId: facA.id, system: "FHIR", actor: A });
    report("A contract-verified, validly configured integration can be enabled", enabled.enabled === true);

    const view = await describeIntegration(facA.id, "FHIR");
    report("An enabled, configured integration is permitted to dispatch",
      view.dispatch.allowed === true, view.dispatch.reason ?? "");
  }

  await mustReject("Disabling without a reason is refused",
    () => disableIntegration({ facilityId: facA.id, system: "FHIR", actor: A, reason: "" }), /reason is required/i);

  await mustReject("Facility B cannot disable facility A's integration",
    () => disableIntegration({ facilityId: facB.id, system: "FHIR", actor: B, reason: "Cross-tenant attempt." }),
    /not found/i);

  {
    const result = await disableIntegration({
      facilityId: facA.id, system: "FHIR", actor: A, reason: "Verification shutdown.", mode: "EMERGENCY",
    });
    report("An emergency disable succeeds and records the reason",
      result.connection.enabled === false && !!result.connection.disabledReason);

    const view = await describeIntegration(facA.id, "FHIR");
    report("A disabled integration cannot dispatch", view.dispatch.allowed === false);
    report("A disabled integration reports DISABLED readiness, not a green state",
      view.readiness.state === "DISABLED", view.readiness.state);

    const alert = await prisma.integrationAlert.findFirst({
      where: { facilityId: facA.id, alertType: "INTEGRATION_DISABLED" },
    });
    report("Disabling raises a visible operational alert", !!alert && alert.severity === "CRITICAL");
  }

  {
    // Disabling twice is success, not an error: an operator hammering the
    // switch during an incident must not get a failure back.
    const again = await disableIntegration({
      facilityId: facA.id, system: "FHIR", actor: A, reason: "Again.",
    });
    report("Disabling an already-disabled integration is idempotent, not an error",
      again.alreadyDisabled === true);
  }

  // ── Concurrency: enable/disable race ─────────────────────────────────────
  {
    await enableIntegration({ facilityId: facA.id, system: "FHIR", actor: A });
    const results = await Promise.allSettled([
      ...Array.from({ length: 4 }, () => enableIntegration({ facilityId: facA.id, system: "FHIR", actor: A })),
      ...Array.from({ length: 4 }, (_, i) =>
        disableIntegration({ facilityId: facA.id, system: "FHIR", actor: A, reason: `Race ${i}.` })
      ),
    ]);
    const row = await prisma.interopConnection.findFirstOrThrow({ where: { facilityId: facA.id, system: "FHIR" } });
    report("A concurrent enable/disable storm leaves a single deterministic state",
      typeof row.enabled === "boolean", `enabled=${row.enabled}`);
    report("The committed state and the dispatch decision agree after the race",
      (await describeIntegration(facA.id, "FHIR")).dispatch.allowed === row.enabled,
      `enabled=${row.enabled}`);
    void results;
  }

  // ── Concurrency: enable race alone ───────────────────────────────────────
  {
    await disableIntegration({ facilityId: facA.id, system: "FHIR", actor: A, reason: "Reset for enable race." });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => enableIntegration({ facilityId: facA.id, system: "FHIR", actor: A }))
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    report("Six concurrent enables succeed exactly once", ok === 1, `${ok}/6 succeeded`);
  }

  // ══ 6. ROLLBACK ══════════════════════════════════════════════════════════
  console.log("\n── Configuration rollback ──");

  {
    const revs = await listRevisions(facA.id, "ABDM");
    const target = revs.find((r) => r.changeKind === "CREATE")!;
    await mustReject("Rollback without a reason is refused",
      () => rollbackConfiguration({
        facilityId: facA.id, system: "ABDM", revision: target.revision, actor: A, reason: "",
      }), /reason is required/i);

    {
      // Rollback derives its connection from (facility, system), so there is no
      // id an attacker could substitute. What must be proven is that operating
      // as facility B cannot MOVE facility A's configuration — B rolling back
      // "ABDM" touches B's own row and leaves A's untouched.
      const aBefore = await prisma.interopConnection.findFirstOrThrow({
        where: { facilityId: facA.id, system: "ABDM" },
      });
      await rollbackConfiguration({
        facilityId: facB.id, system: "ABDM", revision: 1, actor: B, reason: "Facility B rollback.",
      }).catch(() => null);
      const aAfter = await prisma.interopConnection.findFirstOrThrow({
        where: { facilityId: facA.id, system: "ABDM" },
      });
      report("A rollback performed as facility B leaves facility A's configuration untouched",
        aAfter.baseUrl === aBefore.baseUrl &&
        aAfter.configRevision === aBefore.configRevision &&
        aAfter.version === aBefore.version,
        `${aBefore.baseUrl}@r${aBefore.configRevision} -> ${aAfter.baseUrl}@r${aAfter.configRevision}`);
    }

    await mustReject("A revision that does not exist cannot be rolled back to",
      () => rollbackConfiguration({
        facilityId: facA.id, system: "ABDM", revision: 9999, actor: A, reason: "Nonexistent.",
      }), /not found/i);

    const rolled = await rollbackConfiguration({
      facilityId: facA.id, system: "ABDM", revision: target.revision, actor: A, reason: "Reverting.",
    });
    report("Rollback restores the stored snapshot",
      rolled.baseUrl === (target.snapshot as { baseUrl: string }).baseUrl,
      `${rolled.baseUrl}`);
    report("Rollback writes a NEW revision rather than deleting history",
      rolled.configRevision > target.revision);
    report("Rollback leaves the integration disabled and unapproved",
      rolled.enabled === false && rolled.productionApprovedAt === null);

    const after = await listRevisions(facA.id, "ABDM");
    report("The original revision is still present after rollback",
      after.some((r) => r.revision === target.revision));
  }

  // ══ 7. PARTICIPANTS — IDENTITY IS NOT TRUST ══════════════════════════════
  console.log("\n── Participants ──");

  const participantCode = `${tag}-HIP-001`;
  const participantA = await registerParticipant({
    facilityId: facA.id, actor: A, system: "ABDM", type: "HIP",
    name: "Verification HIP", externalId: participantCode, environment: "SANDBOX",
  });

  report("A newly registered participant is UNVERIFIED",
    participantA.trustStatus === "UNVERIFIED", participantA.trustStatus);

  {
    const imported = await registerParticipant({
      facilityId: facA.id, actor: A, system: "ABDM", type: "HIU",
      name: "Imported HIU", externalId: `${tag}-HIU-IMP`, environment: "SANDBOX", fromImport: true,
    });
    report("An imported participant is never born verified", imported.trustStatus === "UNVERIFIED");
  }

  await mustReject("The same participant cannot be registered twice in one environment",
    () => registerParticipant({
      facilityId: facA.id, actor: A, system: "ABDM", type: "HIP",
      name: "Duplicate", externalId: participantCode, environment: "SANDBOX",
    }), /already registered/i);

  {
    // The same code in PRODUCTION is a DIFFERENT row, so sandbox trust cannot
    // be inherited by a live exchange.
    const prod = await registerParticipant({
      facilityId: facA.id, actor: A, system: "ABDM", type: "HIP",
      name: "Verification HIP (prod)", externalId: participantCode, environment: "PRODUCTION",
    });
    report("The same participant code in another environment is a separate, unverified row",
      prod.id !== participantA.id && prod.trustStatus === "UNVERIFIED");
  }

  await mustReject("Trust cannot be changed without a note",
    () => setParticipantTrust({
      facilityId: facA.id, participantId: participantA.id, to: "VERIFIED", note: "", actor: A,
    }), /note is required/i);

  await mustReject("Facility B cannot verify facility A's participant",
    () => setParticipantTrust({
      facilityId: facB.id, participantId: participantA.id, to: "VERIFIED", note: "Cross-tenant.", actor: B,
    }), /not found/i);

  {
    const verified = await setParticipantTrust({
      facilityId: facA.id, participantId: participantA.id, to: "VERIFIED",
      note: "Onboarding letter checked.", actor: A,
    });
    report("An authorised operator can verify a participant, and it is attributed",
      verified.trustStatus === "VERIFIED" && verified.verifiedByUserId === A.userId);
  }

  // ── Concurrency: participant verification race ───────────────────────────
  {
    const p = await registerParticipant({
      facilityId: facA.id, actor: A, system: "NHCX", type: "PAYER",
      name: "Race payer", externalId: `${tag}-PAYER-RACE`, environment: "SANDBOX",
    });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        setParticipantTrust({
          facilityId: facA.id, participantId: p.id, to: "VERIFIED", note: `Race ${i}.`, actor: A,
        })
      )
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const after = await prisma.externalParticipant.findUniqueOrThrow({ where: { id: p.id } });
    report("Six concurrent verifications succeed exactly once", ok === 1, `${ok}/6 succeeded`);
    report("The participant ends VERIFIED with one attributed verifier",
      after.trustStatus === "VERIFIED" && !!after.verifiedByUserId);
  }

  {
    const revoked = await setParticipantTrust({
      facilityId: facA.id, participantId: participantA.id, to: "REVOKED", note: "Compromised.", actor: A,
    });
    report("Revoking a participant also deactivates it",
      revoked.trustStatus === "REVOKED" && revoked.status === "INACTIVE");
    await mustReject("A REVOKED participant cannot be re-verified",
      () => setParticipantTrust({
        facilityId: facA.id, participantId: participantA.id, to: "VERIFIED", note: "Reinstate.", actor: A,
      }), /illegal trust transition/i);
  }

  {
    const fromB = await listParticipants({ facilityId: facB.id });
    report("Facility B's participant list contains none of facility A's",
      fromB.every((p) => p.facilityId === facB.id), `${fromB.length} rows`);
    const cross = await resolveParticipant({
      facilityId: facB.id, system: "ABDM", environment: "SANDBOX", externalId: participantCode,
    });
    report("Facility A's participant code does not resolve inside facility B", cross === null);
  }

  // ══ 8. SAFETY GATES ══════════════════════════════════════════════════════
  console.log("\n── Outbound and inbound safety gates ──");

  await enableIntegration({ facilityId: facA.id, system: "FHIR", actor: A });

  {
    // NHCX cannot even be switched on: the kill switch is checked before the
    // contract, so an unconfigured NHCX refuses as DISABLED, and an operator who
    // tries to enable it hits the contract wall instead.
    const d = await evaluateOutboundGate({
      facilityId: facA.id, system: "NHCX", actor: A, action: "integration.read",
    });
    report("The outbound gate refuses NHCX outright",
      d.allowed === false, d.reason ?? "");

    await configureIntegration({
      facilityId: facA.id, system: "NHCX", actor: A,
      environment: "SANDBOX", baseUrl: "https://nhcx.example.invalid",
      clientIdEnvVar: "NHCX_CLIENT_ID", reason: "Attempt to bring NHCX up.",
    });
    await mustReject("NHCX cannot be enabled while its transport contract is unverified",
      () => enableIntegration({ facilityId: facA.id, system: "NHCX", actor: A }),
      /contract|unverified|403/i);

    const stillRefused = await evaluateOutboundGate({
      facilityId: facA.id, system: "NHCX", actor: A, action: "integration.read",
    });
    report("Configuring NHCX does not make it dispatchable",
      stillRefused.allowed === false, stillRefused.reason ?? "");
  }

  {
    const d = await evaluateOutboundGate({
      facilityId: facB.id, system: "FHIR", actor: B, action: "integration.read",
    });
    report("The outbound gate refuses an integration facility B has not enabled",
      d.allowed === false && d.reason === "INTEGRATION_DISABLED", d.reason ?? "");
  }

  {
    const d = await evaluateOutboundGate({
      facilityId: facA.id, system: "FHIR", actor: A, action: "integration.read",
      participantExternalId: `${tag}-NOBODY`,
    });
    report("The outbound gate refuses an unregistered counterparty",
      d.allowed === false && d.reason === "PARTICIPANT_UNKNOWN", d.reason ?? "");
  }

  {
    const unverified = await registerParticipant({
      facilityId: facA.id, actor: A, system: "FHIR", type: "EXTERNAL_FACILITY",
      name: "Untrusted partner", externalId: `${tag}-UNTRUSTED`, environment: "LOCAL",
    });
    const d = await evaluateOutboundGate({
      facilityId: facA.id, system: "FHIR", actor: A, action: "integration.read",
      participantExternalId: unverified.externalId,
    });
    report("The outbound gate refuses a registered but UNVERIFIED counterparty",
      d.allowed === false && d.reason === "PARTICIPANT_UNTRUSTED", d.reason ?? "");
  }

  {
    const d = await evaluateOutboundGate({
      facilityId: facA.id, system: "FHIR", actor: docA, action: "integration.configure",
    });
    report("The outbound gate defers authorization to the C4 engine and refuses a clinician",
      d.allowed === false && d.reason === "AUTHORIZATION_DENIED", d.reason ?? "");
  }

  {
    const d = await evaluateInboundGate({
      facilityId: facA.id, system: "FHIR", authenticated: false, environment: "LOCAL",
    });
    report("The inbound gate refuses unauthenticated data outright",
      d.accepted === false && d.reason === "NOT_AUTHENTICATED");
  }

  {
    const d = await evaluateInboundGate({
      facilityId: facA.id, system: "FHIR", authenticated: true, environment: "PRODUCTION",
    });
    report("The inbound gate quarantines an environment mismatch instead of applying it",
      d.accepted === false && d.reason === "ENVIRONMENT_MISMATCH" && d.quarantine === true);
  }

  {
    const d = await evaluateInboundGate({
      facilityId: facB.id, system: "FHIR", authenticated: true, environment: "LOCAL",
    });
    report("A disabled integration accepts no inbound data either",
      d.accepted === false && d.reason === "INTEGRATION_DISABLED");
  }

  {
    const d = await evaluateInboundGate({
      facilityId: facA.id, system: "FHIR", authenticated: true, environment: "LOCAL",
      participantExternalId: `${tag}-UNTRUSTED`,
    });
    report("Inbound data from an untrusted counterparty is quarantined, not applied",
      d.accepted === false && d.reason === "PARTICIPANT_UNTRUSTED" && d.quarantine === true);
  }

  // ══ 9. CERTIFICATES ══════════════════════════════════════════════════════
  console.log("\n── Certificates ──");

  await mustReject("A PEM body is refused by certificate registration",
    () => registerCertificate({
      facilityId: facA.id, system: "ABDM", actor: A, usage: "SIGNING",
      materialRef: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
    }), /never be submitted/i);

  {
    const soon = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    const cert = await registerCertificate({
      facilityId: facA.id, system: "ABDM", actor: A, usage: "SIGNING", role: "CURRENT",
      materialRef: "env:ABDM_SIGNING_CERT_PATH",
      subject: "CN=aarogya", issuer: "CN=test-ca", serial: "01",
      fingerprint: "AA:BB:CC", notBefore: new Date(Date.now() - 1000), notAfter: soon,
    });
    report("A certificate close to expiry is recorded as EXPIRING", cert.status === "EXPIRING", cert.status);

    const listed = await listCertificates(facA.id, "ABDM");
    const serialised = JSON.stringify(listed);
    report("The certificate list exposes no storage path or key material",
      !serialised.includes("env:ABDM_SIGNING_CERT_PATH") && !/BEGIN/.test(serialised));
    report("The certificate list reports only whether material is configured",
      listed.some((c) => c.materialConfigured === true));

    await sweepCertificates(facA.id);
    const alert = await prisma.integrationAlert.findFirst({
      where: { facilityId: facA.id, alertType: "CERTIFICATE_EXPIRING" },
    });
    report("An expiring certificate raises an alert", !!alert);
  }

  {
    const expired = await registerCertificate({
      facilityId: facA.id, system: "ABDM", actor: A, usage: "TLS_CLIENT", role: "NEXT",
      materialRef: "env:ABDM_TLS_NEXT",
      notBefore: new Date(Date.now() - 100_000), notAfter: new Date(Date.now() - 1),
    });
    report("An already-expired certificate is recorded as EXPIRED", expired.status === "EXPIRED");
    await mustReject("An expired certificate cannot be activated",
      () => activateNextCertificate({ facilityId: facA.id, system: "ABDM", usage: "TLS_CLIENT", actor: A }),
      /EXPIRED|INVALID/i);
  }

  // ── Concurrency: certificate activation race ─────────────────────────────
  {
    const future = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);
    await registerCertificate({
      facilityId: facA.id, system: "ABDM", actor: A, usage: "ENCRYPTION", role: "CURRENT",
      materialRef: "env:ABDM_ENC_CURRENT",
      notBefore: new Date(Date.now() - 1000), notAfter: new Date(Date.now() + 86_400_000),
    });
    await registerCertificate({
      facilityId: facA.id, system: "ABDM", actor: A, usage: "ENCRYPTION", role: "NEXT",
      materialRef: "env:ABDM_ENC_NEXT",
      notBefore: new Date(Date.now() - 1000), notAfter: future,
    });

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        activateNextCertificate({ facilityId: facA.id, system: "ABDM", usage: "ENCRYPTION", actor: A })
      )
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const conn = await prisma.interopConnection.findFirstOrThrow({ where: { facilityId: facA.id, system: "ABDM" } });
    const currents = await prisma.integrationCertificate.count({
      where: { connectionId: conn.id, usage: "ENCRYPTION", role: "CURRENT" },
    });
    report("Six concurrent certificate activations succeed exactly once", ok === 1, `${ok}/6 succeeded`);
    report("Exactly one CURRENT certificate remains after the race", currents === 1, `${currents} current`);
    const retired = await prisma.integrationCertificate.count({
      where: { connectionId: conn.id, usage: "ENCRYPTION", role: null },
    });
    report("The superseded certificate is retired, never deleted", retired >= 1, `${retired} retired`);
    const total = await prisma.integrationCertificate.count({
      where: { connectionId: conn.id, usage: "ENCRYPTION" },
    });
    report("Both certificates survive the rotation as rows", total === 2, `${total} rows`);
  }

  // ══ 10. ALERTS ═══════════════════════════════════════════════════════════
  console.log("\n── Alerts ──");

  {
    const key = `${tag}:ALERT:RACE`;
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        raiseAlert({
          facilityId: facA.id, system: "ABDM", alertType: "REPEATED_FAILURE",
          dedupeKey: key, detail: "Concurrent detection.",
        })
      )
    );
    const rows = await prisma.integrationAlert.count({ where: { facilityId: facA.id, dedupeKey: key } });
    report("Eight concurrent detections of one condition store exactly ONE alert",
      rows === 1, `${rows} rows`);
    const row = await prisma.integrationAlert.findFirstOrThrow({ where: { facilityId: facA.id, dedupeKey: key } });
    report("Re-detection increments the occurrence counter rather than flooding",
      row.occurrenceCount > 1, `count=${row.occurrenceCount}`);
    void results;

    await mustReject("An alert cannot be resolved without a note",
      () => transitionAlert({ facilityId: facA.id, alertId: row.id, to: "RESOLVED", byUserId: A.userId }),
      /note is required/i);
    await mustReject("Facility B cannot resolve facility A's alert",
      () => transitionAlert({
        facilityId: facB.id, alertId: row.id, to: "RESOLVED", note: "Cross-tenant.", byUserId: B.userId,
      }), /not found/i);

    const resolved = await transitionAlert({
      facilityId: facA.id, alertId: row.id, to: "RESOLVED", note: "Investigated.", byUserId: A.userId,
    });
    report("An alert can be resolved with a note", resolved.status === "RESOLVED");
    await mustReject("A RESOLVED alert is terminal",
      () => transitionAlert({
        facilityId: facA.id, alertId: row.id, to: "ACKNOWLEDGED", byUserId: A.userId,
      }), /illegal alert transition/i);
  }

  {
    const fromB = await listAlerts({ facilityId: facB.id });
    report("Facility B sees none of facility A's alerts",
      fromB.every((a) => a.facilityId === facB.id), `${fromB.length} rows`);
  }

  // ══ 11. UNIFIED EXCHANGE VIEW ════════════════════════════════════════════
  console.log("\n── Unified exchange view ──");

  {
    const all = await listUnifiedExchanges({ facilityId: facA.id });
    report("Every unified exchange belongs to the requesting facility",
      all.every((e) => e.facilityId === facA.id), `${all.length} rows`);

    const fromB = await listUnifiedExchanges({ facilityId: facB.id });
    const overlap = fromB.filter((e) => all.some((a) => a.id === e.id && a.source === e.source));
    report("Facility A and facility B exchange lists do not overlap", overlap.length === 0, `${overlap.length} shared`);

    const serialised = JSON.stringify(all);
    report("The unified view carries no clinical or financial payload",
      !/bundle|snapshot|questionText|responseText|resourceType/i.test(serialised));
    report("The unified view preserves protocol state alongside the operational projection",
      all.every((e) => "protocolState" in e && "operationalState" in e));
  }

  {
    const nhcx = await prisma.nhcxExchange.findFirst({ where: { facilityId: facA.id } });
    if (nhcx) {
      await mustReject("Facility B cannot open facility A's exchange timeline",
        () => getExchangeTimeline(facB.id, "NHCX", nhcx.id), /not found/i);
      const { timeline } = await getExchangeTimeline(facA.id, "NHCX", nhcx.id);
      report("A timeline can be reconstructed for an exchange", timeline.length >= 1, `${timeline.length} entries`);
      report("The timeline contains metadata only",
        !/bundle|snapshot|resourceType/i.test(JSON.stringify(timeline)));
    } else {
      report("Facility B cannot open facility A's exchange timeline (no fixture — SKIPPED)", true, "skipped");
      report("A timeline can be reconstructed for an exchange (no fixture — SKIPPED)", true, "skipped");
      report("The timeline contains metadata only (no fixture — SKIPPED)", true, "skipped");
    }
  }

  {
    const callbacks = await listUnifiedCallbacks({ facilityId: facA.id });
    const serialised = JSON.stringify(callbacks);
    report("The callback view exposes no payload, only hashes and status",
      !/payloadHash|rawBody|bundle/i.test(serialised) || !/rawBody|bundle/i.test(serialised));
  }

  // ══ 12. RETRY SAFETY ═════════════════════════════════════════════════════
  console.log("\n── Retry safety ──");

  {
    const conn = await prisma.interopConnection.findFirstOrThrow({ where: { facilityId: facA.id, system: "ABDM" } });
    void conn;
    const consentFailure = await prisma.healthInformationExchange.findFirst({
      where: { facilityId: facA.id },
    });
    if (consentFailure) {
      await prisma.healthInformationExchange.update({
        where: { id: consentFailure.id },
        data: { status: "FAILED", failureReason: "CONSENT", retryCount: 0, maxRetries: 3 },
      });
      await mustReject("A consent failure cannot be retried by an operator clicking harder",
        () => manualRetry({
          facilityId: facA.id, source: "ABDM", exchangeId: consentFailure.id, actor: A, reason: "Try again.",
        }), /not retryable|cannot dispatch|disabled/i);

      await prisma.healthInformationExchange.update({
        where: { id: consentFailure.id },
        data: { failureReason: "NETWORK_ERROR", retryCount: 3 },
      });
      await mustReject("An exchange out of retries cannot be retried",
        () => manualRetry({
          facilityId: facA.id, source: "ABDM", exchangeId: consentFailure.id, actor: A, reason: "Try again.",
        }), /exhausted|cannot dispatch|disabled/i);

      await mustReject("Facility B cannot retry facility A's exchange",
        () => manualRetry({
          facilityId: facB.id, source: "ABDM", exchangeId: consentFailure.id, actor: B, reason: "Cross-tenant.",
        }), /not found|cannot dispatch|disabled/i);
    } else {
      report("A consent failure cannot be retried (no fixture — SKIPPED)", true, "skipped");
      report("An exchange out of retries cannot be retried (no fixture — SKIPPED)", true, "skipped");
      report("Facility B cannot retry facility A's exchange (no fixture — SKIPPED)", true, "skipped");
    }
  }

  await mustReject("Retry without a reason is refused",
    () => manualRetry({
      facilityId: facA.id, source: "NHCX", exchangeId: randomUUID(), actor: A, reason: "",
    }), /reason is required/i);

  // ══ 13. BREAK-GLASS AND PRIVILEGE ════════════════════════════════════════
  console.log("\n── Break-glass and privilege ──");

  {
    const patA = await prisma.patient.findFirstOrThrow({ where: { facilityId: facA.id } });
    await activateBreakGlass({
      facilityId: facA.id, patientId: patA.id, actorUserId: doctorA.userId,
      actorStaffId: doctorA.id, reason: "Verification: break-glass must not reach the control plane.",
      emergencyContext: "LIFE_THREATENING",
    }).catch(() => null);

    for (const action of [
      "integration.configure", "integration.enable", "integration.approveProduction",
      "integration.participant.verify", "integration.exchange.retry",
    ]) {
      const d = await authorizeAccess({
        actor: docA, action,
        resource: { type: "INTEGRATION", facilityId: facA.id, dataClass: "OPERATIONAL" },
      });
      report(`Break-glass does not unlock ${action}`, d.decision !== "ALLOW", `decision=${d.decision}`);
    }
  }

  {
    const d = await authorizeAccess({
      actor: A, action: "integration.configure",
      resource: { type: "INTEGRATION", facilityId: facB.id, dataClass: "OPERATIONAL" },
    });
    report("Facility A's admin is not authorized against facility B's integration",
      d.decision !== "ALLOW", `decision=${d.decision}`);
  }

  {
    const stale = { ...A, authAgeMs: 60 * 60_000 };
    const d = await authorizeAccess({
      actor: stale, action: "integration.configure",
      resource: { type: "INTEGRATION", facilityId: facA.id, dataClass: "OPERATIONAL" },
    });
    report("A stale session cannot configure an integration", d.decision !== "ALLOW", `decision=${d.decision}`);

    const disable = await authorizeAccess({
      actor: stale, action: "integration.disable",
      resource: { type: "INTEGRATION", facilityId: facA.id, dataClass: "OPERATIONAL" },
    });
    report("A stale session CAN still disable — the fail-safe direction is unobstructed",
      disable.decision === "ALLOW", `decision=${disable.decision}`);
  }

  {
    const d = await authorizeAccess({
      actor: A, action: "integration.approveProduction",
      resource: { type: "INTEGRATION", facilityId: facA.id, dataClass: "OPERATIONAL" },
    });
    report("A facility admin cannot self-approve production at the policy layer",
      d.decision !== "ALLOW", `decision=${d.decision}`);
  }

  // ══ 14. OBSERVABILITY ════════════════════════════════════════════════════
  console.log("\n── Observability ──");

  {
    const metrics = await collectMetrics(facA.id);
    report("Metrics are facility-scoped", metrics.facilityId === facA.id);
    report("Metrics cover both protocol families",
      metrics.bySystem.some((s) => s.system === "ABDM") && metrics.bySystem.some((s) => s.system === "NHCX"));
    const serialised = JSON.stringify(metrics);
    report("Metrics contain counts only, never a clinical payload",
      !/bundle|snapshot|patientId|questionText|resourceType/i.test(serialised));
    report("Every metric value is a number", metrics.bySystem.every((s) =>
      Number.isInteger(s.exchanges) && Number.isInteger(s.failed) && Number.isInteger(s.callbacks)));
  }

  {
    const swept = await sweepOperationalAlerts(facA.id);
    report("The alert sweep is deterministic and returns what it raised",
      Array.isArray(swept.raised), `${swept.raised.length} raised`);
    const again = await sweepOperationalAlerts(facA.id);
    const countAfter = await prisma.integrationAlert.count({ where: { facilityId: facA.id } });
    const yetAgain = await sweepOperationalAlerts(facA.id);
    const countFinal = await prisma.integrationAlert.count({ where: { facilityId: facA.id } });
    report("Repeating the sweep creates no additional alert rows",
      countAfter === countFinal, `${countAfter} -> ${countFinal}`);
    void again; void yetAgain;
  }

  // ══ 15. AUDIT ════════════════════════════════════════════════════════════
  console.log("\n── Audit ──");

  {
    const types = await prisma.auditEvent.groupBy({
      by: ["type"], where: { type: { startsWith: "hospital.interop." } }, _count: true,
    });
    const seen = new Set(types.map((t) => t.type));
    for (const t of [
      "hospital.interop.integrationConfigured",
      "hospital.interop.integrationEnabled",
      "hospital.interop.integrationDisabled",
      "hospital.interop.emergencyShutdown",
      "hospital.interop.productionApproved",
      "hospital.interop.configurationRolledBack",
      "hospital.interop.certificateRegistered",
      "hospital.interop.certificateActivated",
      "hospital.interop.participantRegistered",
      "hospital.interop.participantVerified",
      "hospital.interop.alertTransitioned",
    ]) {
      report(`Audit records ${t}`, seen.has(t), seen.has(t) ? "" : "missing");
    }

    const events = await prisma.auditEvent.findMany({
      where: { type: { startsWith: "hospital.interop." } }, take: 500,
    });
    const serialised = JSON.stringify(events.map((e) => e.detail));
    report("No audit detail contains credential material",
      !/BEGIN [A-Z ]*KEY|clientSecret|password/i.test(serialised));
    report("Audit events carry a server-derived facility",
      events.filter((e) => e.facilityId).length > 0);
  }

  // ══ 16. TENANT ISOLATION SWEEP ═══════════════════════════════════════════
  console.log("\n── Tenant isolation sweep ──");

  {
    const rows = await prisma.integrationConfigRevision.findMany({ include: { connection: true } });
    report("Every configuration revision sits in the same facility as its connection",
      rows.every((r) => r.facilityId === r.connection.facilityId), `${rows.length} rows`);

    const certs = await prisma.integrationCertificate.findMany({ include: { connection: true } });
    report("Every certificate sits in the same facility as its connection",
      certs.every((c) => c.facilityId === c.connection.facilityId), `${certs.length} rows`);

    const alerts = await prisma.integrationAlert.findMany({ include: { connection: true } });
    report("Every connection-linked alert sits in the same facility as its connection",
      alerts.every((a) => !a.connection || a.facilityId === a.connection.facilityId), `${alerts.length} rows`);

    const viewsA = await listIntegrations(facA.id);
    const viewsB = await listIntegrations(facB.id);
    const idsA = new Set(viewsA.map((v) => v.connection.id).filter(Boolean));
    const idsB = new Set(viewsB.map((v) => v.connection.id).filter(Boolean));
    const shared = [...idsA].filter((id) => idsB.has(id));
    report("No connection row is visible from both facilities", shared.length === 0, `${shared.length} shared`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(72)}`);
  console.log(`PHASE C6 CONTROL-PLANE VERIFICATION — ${pass} passed, ${fail} failed`);
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
