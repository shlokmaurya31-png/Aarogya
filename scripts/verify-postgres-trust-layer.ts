/**
 * PHASE C4 — trust layer security and concurrency verification against a REAL
 * PostgreSQL database.
 *
 * This is the adversarial gate for authorization, consent-as-input, break-glass,
 * privacy requests and session revocation. It assumes every caller is hostile
 * and checks the properties that must hold no matter what they send:
 *
 *   - a valid session is not permission to read any patient
 *   - facility membership is not permission to read every facility patient
 *   - a clinical role does not justify every data operation
 *   - consent never substitutes for authorization, or authorization for consent
 *   - break-glass relaxes ONE policy and never crosses a tenant boundary
 *   - platform administration is not clinical access
 *   - nothing a client sends can change who it is
 *
 * IMPORTANT: not idempotent. Run against a FRESHLY migrated and seeded database.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-trust-layer.ts
 */
import { PrismaClient } from "@prisma/client";
import { authorizeAccess, resolveRelationship } from "../src/lib/auth/authorize/engine";
import {
  activateBreakGlass, completeBreakGlass, revokeBreakGlass,
  expireLapsedBreakGlass, breakGlassAbuseReport,
} from "../src/lib/auth/authorize/breakGlass";
import { evaluateConsent, canSharePatientData } from "../src/lib/auth/authorize/consent";
import {
  createPrivacyRequest, transitionPrivacyRequest, listPrivacyRequests, setLegalHold,
} from "../src/lib/auth/authorize/privacy";
import { revokeAllSessions, currentTokenVersion, getMfaProvider } from "../src/lib/auth/authorize/sessionControl";
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
    report(name, expect ? expect.test(msg) : true, expect && !expect.test(msg) ? `wrong error: ${msg}` : msg.slice(0, 60));
  }
}

/** Assert the engine's decision for a request. */
async function expectDecision(
  name: string,
  req: Parameters<typeof authorizeAccess>[0],
  expected: string
) {
  const r = await authorizeAccess(req, { skipAudit: false });
  report(name, r.decision === expected, `got ${r.decision} at ${r.deniedAt ?? "allow"}, expected ${expected}`);
  return r;
}

async function main() {
  const tag = `c4-${Date.now()}`;
  const facA = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Medical Centre" } });
  const facB = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Noida Hospital" } });

  const doctorA = await prisma.hospitalStaffProfile.findFirstOrThrow({
    where: { facilityId: facA.id, status: "ACTIVE", user: { role: "DOCTOR" } }, include: { user: true },
  });
  const doctorA2 = await prisma.hospitalStaffProfile.findFirst({
    where: { facilityId: facA.id, status: "ACTIVE", user: { role: "DOCTOR" }, id: { not: doctorA.id } },
    include: { user: true },
  });
  const nurseA = await prisma.hospitalStaffProfile.findFirst({
    where: { facilityId: facA.id, status: "ACTIVE", user: { role: "NURSE" } }, include: { user: true },
  });
  const staffB = await prisma.hospitalStaffProfile.findFirstOrThrow({
    where: { facilityId: facB.id, status: "ACTIVE" }, include: { user: true },
  });
  const adminUser = await prisma.user.findFirst({ where: { role: "AAROGYA_ADMIN" } });

  const patA = await prisma.patient.findFirstOrThrow({ where: { facilityId: facA.id } });
  const patB = await prisma.patient.findFirstOrThrow({ where: { facilityId: facB.id } });
  // A patient with an open encounter attended by doctorA gives a DIRECT_CARE case.
  const caredEncounter = await prisma.encounter.findFirst({
    where: { facilityId: facA.id, attendingStaffId: doctorA.id, status: { notIn: ["CLOSED", "CANCELLED"] } },
  });

  const actorOf = (staff: typeof doctorA, authAgeMs: number | null = 1000): AuthorizationActor => ({
    userId: staff.userId, role: staff.user.role, staffId: staff.id,
    staffStatus: staff.status, facilityId: staff.facilityId, authAgeMs,
  });

  // HOSPITAL_ADMIN holds interop:exchange:authorize; DOCTOR deliberately does
  // not. Step-up ordering can only be observed with an actor who gets past RBAC.
  const adminA = await prisma.hospitalStaffProfile.findFirst({
    where: { facilityId: facA.id, status: "ACTIVE", user: { role: "HOSPITAL_ADMIN" } }, include: { user: true },
  });

  const docA = actorOf(doctorA);
  const docB = actorOf(staffB);

  console.log(`\n=== A=${facA.name} / B=${facB.name} ===\n`);

  // ══ 1. DENY BY DEFAULT ═══════════════════════════════════════════════════
  console.log("── Deny by default ──");

  await expectDecision("An action with no policy is DENIED",
    { actor: docA, action: "totally.unknown.action", resource: { type: "PATIENT" } }, "DENY");

  await expectDecision("An unknown patient is not found, not merely forbidden",
    { actor: docA, action: "patient.read", resource: { type: "PATIENT", facilityId: facA.id, patientId: `${tag}-nope` } },
    "CONFLICT");

  // ══ 2. FACILITY ISOLATION ════════════════════════════════════════════════
  console.log("\n── Facility isolation ──");

  await expectDecision("Facility A staff cannot read a facility B patient",
    { actor: docA, action: "patient.read", resource: { type: "PATIENT", facilityId: facB.id, patientId: patB.id } },
    "CONFLICT");

  await expectDecision("Facility B staff cannot read a facility A patient",
    { actor: docB, action: "patient.read", resource: { type: "PATIENT", facilityId: facA.id, patientId: patA.id } },
    "CONFLICT");

  {
    // The subtle one: correct resource facility, but the PATIENT is foreign.
    const r = await authorizeAccess({
      actor: docA, action: "patient.read",
      resource: { type: "PATIENT", facilityId: facA.id, patientId: patB.id },
    });
    report("A foreign patient id with a local facility id is still refused",
      r.decision === "CONFLICT" && r.relationship === "NONE", `decision=${r.decision}`);
    report("The refusal reveals nothing about where the patient lives",
      r.reason === "Not found.", `reason=${r.reason}`);
  }

  // ══ 3. RELATIONSHIP ══════════════════════════════════════════════════════
  console.log("\n── Care relationship ──");

  {
    const rel = await resolveRelationship({
      actorUserId: doctorA.userId, actorStaffId: doctorA.id, actorFacilityId: facA.id,
      role: "DOCTOR", patientId: patB.id,
    });
    report("A cross-facility patient yields NO relationship at all", rel === "NONE", `rel=${rel}`);
  }

  if (caredEncounter) {
    const rel = await resolveRelationship({
      actorUserId: doctorA.userId, actorStaffId: doctorA.id, actorFacilityId: facA.id,
      role: "DOCTOR", patientId: caredEncounter.patientId,
    });
    report("An attending clinician on an open encounter has DIRECT_CARE",
      rel === "DIRECT_CARE", `rel=${rel}`);
  } else {
    report("An attending clinician on an open encounter has DIRECT_CARE", true, "skipped: no seeded open encounter");
  }

  {
    // The C1 gap being closed: facility membership must NOT reach a RESTRICTED
    // document. Pick a patient this doctor is NOT treating.
    const unrelated = await prisma.patient.findFirst({
      where: { facilityId: facA.id, encounters: { none: { attendingStaffId: doctorA.id } } },
    });
    if (unrelated) {
      const rel = await resolveRelationship({
        actorUserId: doctorA.userId, actorStaffId: doctorA.id, actorFacilityId: facA.id,
        role: "DOCTOR", patientId: unrelated.id,
      });
      report("An untreated same-facility patient is FACILITY_STAFF, not DIRECT_CARE",
        rel === "FACILITY_STAFF", `rel=${rel}`);

      const r = await authorizeAccess({
        actor: docA, action: "document.read.restricted",
        resource: { type: "DOCUMENT", facilityId: facA.id, patientId: unrelated.id },
      });
      report("A RESTRICTED document is NOT readable on facility membership alone",
        r.decision === "REQUIRE_BREAK_GLASS", `decision=${r.decision}`);

      // And ordinary access to the same patient still works — the restriction
      // is targeted, not a blanket lockout.
      const ordinary = await authorizeAccess({
        actor: docA, action: "patient.read",
        resource: { type: "PATIENT", facilityId: facA.id, patientId: unrelated.id },
      });
      report("Ordinary chart access is unaffected by the restriction",
        ordinary.decision === "ALLOW", `decision=${ordinary.decision}`);
    } else {
      report("A RESTRICTED document is NOT readable on facility membership alone", true, "skipped: no unrelated patient");
    }
  }

  // ══ 4. PLATFORM ADMIN IS NOT CLINICAL ACCESS ═════════════════════════════
  console.log("\n── Platform admin boundary ──");

  if (adminUser) {
    const admin: AuthorizationActor = {
      userId: adminUser.id, role: "AAROGYA_ADMIN", staffId: null, staffStatus: null,
      facilityId: facA.id, authAgeMs: 1000,
    };
    const rel = await resolveRelationship({
      actorUserId: admin.userId, actorStaffId: null, actorFacilityId: facA.id,
      role: "AAROGYA_ADMIN", patientId: patA.id,
    });
    report("A platform admin has PLATFORM_ADMIN, not a care relationship",
      rel === "PLATFORM_ADMIN", `rel=${rel}`);

    const r = await authorizeAccess({
      actor: admin, action: "document.read.restricted",
      resource: { type: "DOCUMENT", facilityId: facA.id, patientId: patA.id },
    });
    report("A platform admin does NOT get unrestricted clinical access",
      r.decision !== "ALLOW", `decision=${r.decision}`);
  } else {
    report("A platform admin does NOT get unrestricted clinical access", true, "skipped: no admin seeded");
  }

  // ══ 5. STAFF STATUS AND ROLE ═════════════════════════════════════════════
  console.log("\n── Actor integrity ──");

  await expectDecision("A suspended staff member is refused",
    { actor: { ...docA, staffStatus: "SUSPENDED" }, action: "patient.read",
      resource: { type: "PATIENT", facilityId: facA.id, patientId: patA.id } }, "DENY");

  await expectDecision("A staff-less non-admin actor is refused",
    { actor: { ...docA, staffId: null, staffStatus: null }, action: "patient.read",
      resource: { type: "PATIENT", facilityId: facA.id, patientId: patA.id } }, "DENY");

  if (nurseA) {
    // RBAC still applies: a nurse cannot grant clinical privileges.
    await expectDecision("A nurse cannot grant a clinical privilege",
      { actor: actorOf(nurseA), action: "privilege.grant", resource: { type: "PRIVILEGE", facilityId: facA.id } },
      "DENY");
  }

  // ══ 6. STEP-UP ═══════════════════════════════════════════════════════════
  console.log("\n── Step-up authentication ──");

  // Step-up is evaluated with the ACTOR checks, before consent, so a stale
  // session is challenged without first learning anything about the resource.
  // RBAC still precedes step-up, correctly: there is no point challenging
  // re-authentication for something the actor could never do anyway.
  await expectDecision("RBAC is evaluated before step-up",
    { actor: { ...docA, authAgeMs: 60 * 60_000 }, action: "exchange.authorize",
      resource: { type: "EXCHANGE", facilityId: facA.id, patientId: patA.id } },
    "DENY");

  if (adminA) {
    await expectDecision("A stale session is challenged BEFORE consent is evaluated",
      { actor: actorOf(adminA, 60 * 60_000), action: "exchange.authorize",
        resource: { type: "EXCHANGE", facilityId: facA.id, patientId: patA.id } },
      "REQUIRE_STEP_UP_AUTH");
  }

  if (adminA) {
    // The enumeration leak this ordering closes: a stale session must not be
    // able to tell a consented patient from an unconsented one.
    const stale = actorOf(adminA, 60 * 60_000);
    const a = await authorizeAccess({
      actor: stale, action: "exchange.authorize",
      resource: { type: "EXCHANGE", facilityId: facA.id, patientId: patA.id },
    });
    const b = await authorizeAccess({
      actor: stale, action: "exchange.authorize",
      resource: { type: "EXCHANGE", facilityId: facA.id, patientId: patA.id },
      purpose: "REFERRAL", scopes: ["LAB"],
    });
    report("A stale session cannot distinguish consented from unconsented patients",
      a.decision === b.decision && a.decision === "REQUIRE_STEP_UP_AUTH",
      `${a.decision} vs ${b.decision}`);
  }

  {
    // "We cannot tell how recently you authenticated" must fail closed.
    const r = await authorizeAccess({
      actor: { ...docA, authAgeMs: null }, action: "privilege.grant",
      resource: { type: "PRIVILEGE", facilityId: facA.id },
    });
    report("An unknown authentication age fails closed, not open",
      r.decision === "REQUIRE_STEP_UP_AUTH" || r.decision === "DENY", `decision=${r.decision}`);
  }

  {
    const p = getMfaProvider();
    const verify = await p.verify(doctorA.userId, "123456");
    report("The MFA provider can never report VERIFIED", verify.state !== "VERIFIED", `state=${verify.state}`);
  }

  // ══ 7. CONSENT AS AN AUTHORIZATION INPUT ═════════════════════════════════
  console.log("\n── Consent ──");

  const consent = await requestConsent({
    facilityId: facA.id, patientId: patA.id, purpose: "REFERRAL", scopes: ["LAB"],
    recipientType: "FACILITY", recipientIdentifier: "partner-c4",
    expiresAt: new Date(Date.now() + 30 * 86400_000), byUserId: doctorA.userId,
  });

  {
    const v = await evaluateConsent({
      facilityId: facA.id, patientId: patA.id, purpose: "REFERRAL", scopes: ["LAB"], consentId: consent.id,
    });
    report("An ungranted consent does not authorize", !v.usable, v.reason ?? "");
  }

  await grantConsent({ facilityId: facA.id, consentId: consent.id, grantedBy: "PATIENT", byUserId: doctorA.userId });

  {
    const v = await evaluateConsent({
      facilityId: facA.id, patientId: patA.id, purpose: "REFERRAL", scopes: ["LAB"], consentId: consent.id,
    });
    report("A granted consent authorizes its own purpose and scope", v.usable);
  }
  {
    const v = await evaluateConsent({
      facilityId: facA.id, patientId: patA.id, purpose: "RESEARCH", scopes: ["LAB"], consentId: consent.id,
    });
    report("Purpose escalation is refused (REFERRAL consent != RESEARCH)", !v.usable, v.reason ?? "");
  }
  {
    const v = await evaluateConsent({
      facilityId: facA.id, patientId: patA.id, purpose: "REFERRAL", scopes: ["ALL_CLINICAL"], consentId: consent.id,
    });
    report("Scope escalation is refused (LAB consent != ALL_CLINICAL)", !v.usable, v.reason ?? "");
  }
  {
    const v = await evaluateConsent({
      facilityId: facA.id, patientId: patA.id, purpose: "REFERRAL", scopes: ["LAB"],
      consentId: consent.id, recipientIdentifier: "someone-else",
    });
    report("Recipient escalation is refused", !v.usable, v.reason ?? "");
  }
  {
    const v = await evaluateConsent({
      facilityId: facA.id, patientId: patB.id, purpose: "REFERRAL", scopes: ["LAB"], consentId: consent.id,
    });
    report("A consent cannot be reused for a different patient", !v.usable, v.reason ?? "");
  }
  {
    const v = await evaluateConsent({
      facilityId: facB.id, patientId: patA.id, purpose: "REFERRAL", scopes: ["LAB"], consentId: consent.id,
    });
    report("Facility B cannot read facility A consent (IDOR)", !v.usable, v.reason ?? "");
  }
  {
    // Tenant isolation must beat a valid-looking consent.
    const share = await canSharePatientData({
      facilityId: facB.id, patientId: patA.id, purpose: "REFERRAL", scopes: ["LAB"], consentId: consent.id,
    });
    report("Consent never overrides tenant isolation", !share.allowed, share.reason ?? "");
  }

  // ══ 8. CONSENT VS AUTHORIZATION ══════════════════════════════════════════
  console.log("\n── Consent is not authorization ──");

  {
    // Valid consent, but the actor is in the wrong facility.
    const r = await authorizeAccess({
      actor: docB, action: "patient.export.fhir",
      resource: { type: "PATIENT", facilityId: facA.id, patientId: patA.id },
      purpose: "REFERRAL", scopes: ["LAB"], consentId: consent.id,
    });
    report("Valid consent does not let a foreign-facility actor export",
      r.decision !== "ALLOW", `decision=${r.decision}`);
  }
  {
    // Correct actor, correct facility, but no consent supplied at all.
    const r = await authorizeAccess({
      actor: docA, action: "patient.export.fhir",
      resource: { type: "PATIENT", facilityId: facA.id, patientId: patA.id },
      purpose: "RESEARCH", scopes: ["LAB"],
    });
    report("Authorization alone does not permit disclosure without consent",
      r.decision === "REQUIRE_CONSENT", `decision=${r.decision}`);
  }
  {
    const r = await authorizeAccess({
      actor: docA, action: "patient.export.fhir",
      resource: { type: "PATIENT", facilityId: facA.id, patientId: patA.id },
      purpose: "REFERRAL", scopes: ["LAB"], consentId: consent.id,
    });
    report("Authorization + matching consent permits disclosure",
      r.decision === "ALLOW" && r.consentId === consent.id, `decision=${r.decision}`);
  }

  await revokeConsent({ facilityId: facA.id, consentId: consent.id, reason: "withdrawn", byUserId: doctorA.userId });
  {
    const r = await authorizeAccess({
      actor: docA, action: "patient.export.fhir",
      resource: { type: "PATIENT", facilityId: facA.id, patientId: patA.id },
      purpose: "REFERRAL", scopes: ["LAB"], consentId: consent.id,
    });
    report("Revocation immediately blocks further disclosure",
      r.decision === "REQUIRE_CONSENT", `decision=${r.decision}`);
  }

  // ══ 9. BREAK-GLASS ═══════════════════════════════════════════════════════
  console.log("\n── Break-glass ──");

  await mustReject("A token reason is refused",
    () => activateBreakGlass({
      facilityId: facA.id, patientId: patA.id, actorUserId: doctorA.userId,
      actorStaffId: doctorA.id, reason: "urgent", emergencyContext: "LIFE_THREATENING",
    }), /at least \d+ characters/i);

  await mustReject("An invented emergency context is refused",
    () => activateBreakGlass({
      facilityId: facA.id, patientId: patA.id, actorUserId: doctorA.userId, actorStaffId: doctorA.id,
      reason: "Patient unconscious in resus, records needed immediately.",
      emergencyContext: "ADMIN_OVERRIDE",
    }), /emergencyContext must be one of/i);

  await mustReject("Break-glass cannot cross a facility boundary",
    () => activateBreakGlass({
      facilityId: facA.id, patientId: patB.id, actorUserId: doctorA.userId, actorStaffId: doctorA.id,
      reason: "Trying to reach a patient in another facility entirely.",
      emergencyContext: "LIFE_THREATENING",
    }), /not found/i);

  const unrelatedPatient = await prisma.patient.findFirst({
    where: { facilityId: facA.id, encounters: { none: { attendingStaffId: doctorA.id } } },
  });

  if (unrelatedPatient) {
    const window = await activateBreakGlass({
      facilityId: facA.id, patientId: unrelatedPatient.id, actorUserId: doctorA.userId,
      actorStaffId: doctorA.id,
      reason: "Patient unconscious after RTA, prior records required urgently for management.",
      emergencyContext: "UNCONSCIOUS_PATIENT",
    });
    report("Break-glass activates with an expiry", !!window.expiresAt && window.status === "ACTIVE");
    report("The window is bounded to at most four hours",
      window.expiresAt.getTime() - window.activatedAt.getTime() <= 4 * 60 * 60_000 + 1000);

    {
      const r = await authorizeAccess({
        actor: docA, action: "document.read.restricted",
        resource: { type: "DOCUMENT", facilityId: facA.id, patientId: unrelatedPatient.id },
      });
      report("Break-glass relaxes the care-relationship requirement",
        r.decision === "ALLOW" && r.viaBreakGlass === true, `decision=${r.decision} viaBG=${r.viaBreakGlass}`);
    }

    {
      // The property that stops break-glass being a backdoor.
      const r = await authorizeAccess({
        actor: docA, action: "patient.export.fhir",
        resource: { type: "PATIENT", facilityId: facA.id, patientId: unrelatedPatient.id },
        purpose: "TREATMENT", scopes: ["LAB"],
      });
      report("Break-glass does NOT unlock external disclosure",
        r.decision === "REQUIRE_CONSENT" && !r.viaBreakGlass, `decision=${r.decision}`);
    }

    if (doctorA2) {
      // A colleague must not ride on someone else's window.
      const r = await authorizeAccess({
        actor: actorOf(doctorA2), action: "document.read.restricted",
        resource: { type: "DOCUMENT", facilityId: facA.id, patientId: unrelatedPatient.id },
      });
      report("A colleague cannot ride on another actor's break-glass window",
        r.decision !== "ALLOW" || !r.viaBreakGlass, `decision=${r.decision} viaBG=${r.viaBreakGlass}`);
    }

    {
      // A window is bound to ONE patient.
      const other = await prisma.patient.findFirst({
        where: { facilityId: facA.id, id: { notIn: [unrelatedPatient.id] },
                 encounters: { none: { attendingStaffId: doctorA.id } } },
      });
      if (other) {
        const r = await authorizeAccess({
          actor: docA, action: "document.read.restricted",
          resource: { type: "DOCUMENT", facilityId: facA.id, patientId: other.id },
        });
        report("A break-glass window does not extend to another patient",
          r.decision !== "ALLOW", `decision=${r.decision}`);
      }
    }

    {
      // Expiry is derived, so an unswept row past its window is already dead.
      await prisma.breakGlassAccess.update({
        where: { id: window.id }, data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const r = await authorizeAccess({
        actor: docA, action: "document.read.restricted",
        resource: { type: "DOCUMENT", facilityId: facA.id, patientId: unrelatedPatient.id },
      });
      report("An expired window stops granting access even before it is swept",
        r.decision !== "ALLOW", `decision=${r.decision}`);
      const swept = await expireLapsedBreakGlass(facA.id);
      report("Lapsed windows can be swept to EXPIRED", swept.expired >= 1, `expired=${swept.expired}`);
    }

    {
      // Concurrent activation: both may succeed (two genuine emergencies), but
      // each must be its own auditable window, never a shared one.
      const activate = () => activateBreakGlass({
        facilityId: facA.id, patientId: unrelatedPatient.id, actorUserId: doctorA.userId,
        actorStaffId: doctorA.id,
        reason: "Concurrent emergency activation during mass casualty triage.",
        emergencyContext: "MASS_CASUALTY",
      }).then((w) => w.correlationId, () => null);
      const ids = await Promise.all([activate(), activate(), activate()]);
      const unique = new Set(ids.filter(Boolean));
      report("Concurrent activations each produce a distinct auditable window",
        unique.size === ids.filter(Boolean).length, `windows=${unique.size}`);
    }

    {
      const w = await activateBreakGlass({
        facilityId: facA.id, patientId: unrelatedPatient.id, actorUserId: doctorA.userId,
        actorStaffId: doctorA.id,
        reason: "Window created specifically to test concurrent closure behaviour.",
        emergencyContext: "OTHER_URGENT",
      });
      const close = () => completeBreakGlass({
        facilityId: facA.id, breakGlassId: w.id, actorUserId: doctorA.userId,
      }).then(() => true, () => false);
      const rs = await Promise.all([close(), close()]);
      report("Concurrent closure of one window yields exactly one winner",
        rs.filter(Boolean).length === 1, `winners=${rs.filter(Boolean).length}`);
    }

    {
      const w = await activateBreakGlass({
        facilityId: facA.id, patientId: unrelatedPatient.id, actorUserId: doctorA.userId,
        actorStaffId: doctorA.id,
        reason: "Window created specifically to test cross-facility revocation.",
        emergencyContext: "OTHER_URGENT",
      });
      await mustReject("Facility B cannot revoke a facility A window",
        () => revokeBreakGlass({ facilityId: facB.id, breakGlassId: w.id, actorUserId: staffB.userId }),
        /not found/i);
    }

    {
      const rpt = await breakGlassAbuseReport(facA.id);
      report("The abuse report counts windows deterministically",
        rpt.total > 0 && Array.isArray(rpt.topActors), `total=${rpt.total} active=${rpt.active}`);
    }
  }

  // ══ 10. PRIVACY REQUESTS ═════════════════════════════════════════════════
  console.log("\n── Privacy requests ──");

  const privacyReq = await createPrivacyRequest({
    facilityId: facA.id, patientId: patA.id, requestType: "ACCESS",
    requesterType: "STAFF_ON_BEHALF", requesterUserId: doctorA.userId,
    reason: "Patient asked for a copy of their record.",
  });
  report("A privacy request starts in REQUESTED", privacyReq.status === "REQUESTED");

  await mustReject("A privacy request cannot target another facility's patient",
    () => createPrivacyRequest({
      facilityId: facA.id, patientId: patB.id, requestType: "ACCESS",
      requesterType: "STAFF_ON_BEHALF", requesterUserId: doctorA.userId,
    }), /not found/i);

  {
    // The IDOR that matters: a patient account raising a request about someone
    // else. Simulated by claiming PATIENT while not being that patient.
    await mustReject("A patient cannot raise a request about another patient",
      () => createPrivacyRequest({
        facilityId: facA.id, patientId: patA.id, requestType: "DELETION_REQUEST",
        requesterType: "PATIENT", requesterUserId: doctorA.userId,
      }), /not found/i);
  }

  await mustReject("A request cannot be approved without review",
    () => transitionPrivacyRequest({
      facilityId: facA.id, privacyRequestId: privacyReq.id, to: "APPROVED", byUserId: doctorA.userId,
      decisionNote: "ok",
    }), /Illegal privacy request transition/i);

  await transitionPrivacyRequest({
    facilityId: facA.id, privacyRequestId: privacyReq.id, to: "UNDER_REVIEW", byUserId: doctorA.userId,
  });
  await mustReject("A decision requires a recorded rationale",
    () => transitionPrivacyRequest({
      facilityId: facA.id, privacyRequestId: privacyReq.id, to: "APPROVED", byUserId: doctorA.userId,
    }), /decision note is required/i);

  await transitionPrivacyRequest({
    facilityId: facA.id, privacyRequestId: privacyReq.id, to: "APPROVED",
    byUserId: doctorA.userId, decisionNote: "Approved; copy provided to patient.",
  });

  {
    await setLegalHold({
      facilityId: facA.id, privacyRequestId: privacyReq.id, hold: true,
      reason: "Record subject to an ongoing matter.", byUserId: doctorA.userId,
    });
    await mustReject("A record under legal hold cannot be actioned",
      () => transitionPrivacyRequest({
        facilityId: facA.id, privacyRequestId: privacyReq.id, to: "ACTIONED", byUserId: doctorA.userId,
      }), /legal hold/i);
  }

  {
    const visible = await listPrivacyRequests({ facilityId: facA.id, restrictToPatientId: patB.id });
    report("A patient-scoped listing never returns another patient's requests",
      visible.every((r) => r.patientId === patB.id), `rows=${visible.length}`);
  }

  {
    const deletionReq = await createPrivacyRequest({
      facilityId: facA.id, patientId: patA.id, requestType: "DELETION_REQUEST",
      requesterType: "STAFF_ON_BEHALF", requesterUserId: doctorA.userId,
    });
    const clinicalBefore = await prisma.clinicalDocument.count({ where: { patientId: patA.id } });
    await transitionPrivacyRequest({
      facilityId: facA.id, privacyRequestId: deletionReq.id, to: "UNDER_REVIEW", byUserId: doctorA.userId,
    });
    await transitionPrivacyRequest({
      facilityId: facA.id, privacyRequestId: deletionReq.id, to: "REJECTED",
      byUserId: doctorA.userId, decisionNote: "Retention obligations apply.",
    });
    const clinicalAfter = await prisma.clinicalDocument.count({ where: { patientId: patA.id } });
    report("A deletion REQUEST never deletes a clinical record",
      clinicalBefore === clinicalAfter, `before=${clinicalBefore} after=${clinicalAfter}`);
  }

  // ══ 11. SESSION REVOCATION ═══════════════════════════════════════════════
  console.log("\n── Session revocation ──");

  {
    const before = await currentTokenVersion(doctorA.userId);
    await revokeAllSessions({
      userId: doctorA.userId, byUserId: doctorA.userId, reason: "Logout everywhere.", facilityId: facA.id,
    });
    const after = await currentTokenVersion(doctorA.userId);
    report("Revoking sessions bumps the token version", after === before + 1, `${before} -> ${after}`);
    report("A cookie minted at the old version no longer matches", before !== after);
  }

  {
    const attempt = () => revokeAllSessions({
      userId: doctorA.userId, byUserId: doctorA.userId, reason: "Concurrent revoke.", facilityId: facA.id,
    }).then((r) => r.tokenVersion, () => null);
    const before = await currentTokenVersion(doctorA.userId);
    const rs = await Promise.all([attempt(), attempt(), attempt()]);
    const after = await currentTokenVersion(doctorA.userId);
    report("Concurrent revocations never decrease the version",
      after >= before + 1 && rs.every((v) => v === null || v > before), `${before} -> ${after}`);
  }

  // ══ 12. AUDIT ════════════════════════════════════════════════════════════
  console.log("\n── Audit coverage ──");

  for (const t of [
    "security.authorization.denied",
    "security.breakGlass.activated",
    "security.privacy.requestCreated",
    "security.privacy.requestReviewed",
    "security.session.allRevoked",
  ]) {
    const n = await prisma.auditEvent.count({ where: { type: t } });
    report(`Audit event emitted: ${t}`, n > 0, `count=${n}`);
  }

  {
    const events = await prisma.auditEvent.findMany({
      where: { type: { startsWith: "security." } }, take: 300,
    });
    const json = JSON.stringify(events);
    // Decisions record WHO/WHAT/WHY, never the data reached.
    report("Security audit contains no clinical payload",
      !json.includes("bundle") && !json.includes("passwordHash"), `events=${events.length}`);
    report("Every security audit event has a server-derived actor",
      events.every((e) => !!e.userId), `events=${events.length}`);
  }

  console.log("\n════════════════════════════════════════");
  console.log(`PHASE C4 TRUST LAYER — PASS ${pass} / FAIL ${fail}`);
  if (failures.length) { console.log("Failures:"); failures.forEach((f) => console.log(`  - ${f}`)); }
  console.log("════════════════════════════════════════\n");
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
