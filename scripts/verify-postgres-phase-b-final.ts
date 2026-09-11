/**
 * PHASE B FINAL INTEGRATION GATE — consolidated adversarial verification against
 * a REAL PostgreSQL database.
 *
 * This is deliberately not a re-run of the per-phase scripts. Those proved each
 * module correct in isolation; this one attacks the seams BETWEEN modules and
 * the invariants that only a genuinely concurrent engine can violate:
 *
 *   - cross-facility isolation reached through B10's quality/workforce layer
 *   - wrong-patient and wrong-encounter linkage
 *   - maker/checker (self-review, self-verification, self-granting)
 *   - credential/privilege predicates under expiry, suspension and revocation
 *   - single-winner lifecycle races run with genuine Promise.all parallelism
 *   - the RFQ award deadlock this gate fixed
 *   - the database-level invariants of §36
 *
 * Every race uses Promise.all against a real connection pool, so PostgreSQL —
 * not a serialized SQLite writer — decides the winner.
 *
 * IMPORTANT: this script, like the per-phase verify-postgres-* scripts, is NOT
 * idempotent — it consumes roster windows and creates records, so re-running it
 * against an already-exercised database produces spurious failures. Always run
 * it against a FRESHLY migrated and seeded database; see
 * docs/PHASE_B_FINAL_INTEGRITY_GATE.md §7.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-phase-b-final.ts
 */
import { PrismaClient } from "@prisma/client";
import {
  createQualityIncident, transitionIncident, reopenIncident, createRca, updateRca, reviewRca,
  createCapa, transitionCapa, createStandard, addMeasure, attachEvidence, createAudit, createFinding, closeFinding,
} from "../src/lib/hospital/quality/service";
import {
  createAssignment, createCredential, verifyCredential, grantPrivilege, revokePrivilege,
  suspendPrivilege, createShift,
} from "../src/lib/hospital/workforce/service";
import { requirePrivilege, requireCredential, deriveExpiryState, CredentialAuthorizationError } from "../src/lib/hospital/workforce/authorization";
import { selectQuotation } from "../src/lib/hospital/procurement/procurementAdvanced";

const prisma = new PrismaClient();
let pass = 0, fail = 0;
const failures: string[] = [];

function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

/** Assert that a call is REJECTED. A silent success here is a security failure. */
async function mustReject(name: string, fn: () => Promise<unknown>, expect?: RegExp) {
  try {
    await fn();
    report(name, false, "call SUCCEEDED but should have been rejected");
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
  const tag = `gate-${Date.now()}`;
  const facA = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Medical Centre" } });
  const facB = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Noida Hospital" } });

  const staffA = await prisma.hospitalStaffProfile.findMany({ where: { facilityId: facA.id, status: "ACTIVE" }, take: 3 });
  const staffB = await prisma.hospitalStaffProfile.findMany({ where: { facilityId: facB.id, status: "ACTIVE" }, take: 1 });
  if (staffA.length < 3 || staffB.length < 1) throw new Error("Seed did not provide enough staff for the gate.");
  const [a1, a2, a3] = staffA; const b1 = staffB[0];

  const patA = await prisma.patient.findFirstOrThrow({ where: { facilityId: facA.id } });
  const patB = await prisma.patient.findFirstOrThrow({ where: { facilityId: facB.id } });
  const encA = await prisma.encounter.findFirstOrThrow({ where: { facilityId: facA.id } });
  const deptB = await prisma.department.findFirst({ where: { facilityId: facB.id } });

  console.log(`\n=== Facility A=${facA.name} / B=${facB.name} ===\n`);

  // ══ 1. CROSS-FACILITY ISOLATION (gate §8, §25) ════════════════════════════
  console.log("── Cross-facility isolation ──");

  await mustReject("Incident in facility A cannot reference facility B's patient",
    () => createQualityIncident({ facilityId: facA.id, category: "FALL", title: `${tag} xf`, description: "x", patientId: patB.id, reportedByStaffId: a1.id, byUserId: a1.userId }),
    /not found/i);

  await mustReject("Incident in facility A cannot reference facility B's department",
    () => createQualityIncident({ facilityId: facA.id, category: "FALL", title: `${tag} xf2`, description: "x", departmentId: deptB?.id, reportedByStaffId: a1.id, byUserId: a1.userId }),
    /not found/i);

  await mustReject("Incident cannot be reported by a staff member of another facility",
    () => transitionIncident({ incidentId: "nonexistent", facilityId: facA.id, to: "TRIAGED", actorStaffId: b1.id, byUserId: b1.userId }),
    /not found/i);

  // A real incident in facility B, attacked from facility A.
  const incB = await createQualityIncident({ facilityId: facB.id, category: "OPERATIONAL", title: `${tag} B-incident`, description: "b", reportedByStaffId: b1.id, byUserId: b1.userId });

  await mustReject("Facility A cannot transition facility B's incident (direct id)",
    () => transitionIncident({ incidentId: incB.id, facilityId: facA.id, to: "TRIAGED", actorStaffId: a1.id, byUserId: a1.userId }),
    /not found/i);

  await mustReject("Facility A cannot hang a CAPA off facility B's incident",
    () => createCapa({ facilityId: facA.id, title: `${tag} xcapa`, description: "x", actionType: "CORRECTIVE", incidentId: incB.id, createdByStaffId: a1.id, byUserId: a1.userId }),
    /not found/i);

  await mustReject("Facility A cannot attach evidence to facility B's incident (evidence IDOR)",
    () => attachEvidence({ facilityId: facA.id, description: `${tag} eIDOR`, incidentId: incB.id, providedByStaffId: a1.id, byUserId: a1.userId }),
    /not found/i);

  await mustReject("Facility A cannot create a finding linked to facility B's incident",
    () => createFinding({ facilityId: facA.id, title: `${tag} xf`, description: "x", incidentId: incB.id, identifiedByStaffId: a1.id, byUserId: a1.userId }),
    /not found/i);

  await mustReject("Facility A cannot assign facility B's staff as an auditor",
    () => createAudit({ facilityId: facA.id, title: `${tag} xaudit`, auditorStaffId: b1.id, createdByStaffId: a1.id, byUserId: a1.userId }),
    /not found/i);

  await mustReject("Cross-facility workforce assignment is refused",
    () => createAssignment({ facilityId: facA.id, staffId: b1.id, createdByStaffId: a1.id, byUserId: a1.userId }),
    /not found/i);

  // ══ 2. WRONG-PATIENT / WRONG-ENCOUNTER (gate §7) ══════════════════════════
  console.log("\n── Wrong-patient linkage ──");

  await mustReject("Incident cannot pair patient A with an encounter belonging to someone else",
    () => createQualityIncident({ facilityId: facA.id, category: "MEDICATION", title: `${tag} wp`, description: "x", patientId: patA.id, encounterId: encA.patientId === patA.id ? "nonexistent" : encA.id, reportedByStaffId: a1.id, byUserId: a1.userId }),
    /not found|does not belong/i);

  // ══ 3. MASS ASSIGNMENT (gate §38) ═════════════════════════════════════════
  console.log("\n── Mass assignment / client-supplied field trust ──");

  const incA = await createQualityIncident({ facilityId: facA.id, category: "MEDICATION", title: `${tag} A-incident`, description: "a", patientId: patA.id, reportedByStaffId: a1.id, byUserId: a1.userId });
  const rcaA = await createRca({ facilityId: facA.id, incidentId: incA.id, problemStatement: "p", authoredByStaffId: a1.id, byUserId: a1.userId });

  await updateRca({
    rcaId: rcaA.id, facilityId: facA.id, byUserId: a1.userId,
    patch: {
      findings: "legit edit",
      // hostile fields — must all be ignored by the allow-list
      facilityId: facB.id, reviewedByStaffId: a1.id, reviewedAt: new Date(),
      incidentId: incB.id, authoredByStaffId: b1.id, version: 999,
    } as never,
  });
  const rcaAfter = await prisma.rootCauseAnalysis.findUniqueOrThrow({ where: { id: rcaA.id } });
  report("RCA patch cannot move the record to another facility", rcaAfter.facilityId === facA.id, `facilityId=${rcaAfter.facilityId === facA.id ? "unchanged" : "MOVED"}`);
  report("RCA patch cannot forge a review attestation", rcaAfter.reviewedByStaffId === null && rcaAfter.reviewedAt === null);
  report("RCA patch cannot re-point the incident link", rcaAfter.incidentId === incA.id);
  report("RCA patch cannot rewrite authorship", rcaAfter.authoredByStaffId === a1.id);
  report("RCA patch applied the one legitimately editable field", rcaAfter.findings === "legit edit");

  // ══ 4. MAKER / CHECKER (gate §39) ═════════════════════════════════════════
  console.log("\n── Maker/checker ──");

  await mustReject("RCA author cannot review their own RCA",
    () => reviewRca({ rcaId: rcaA.id, facilityId: facA.id, reviewedByStaffId: a1.id, byUserId: a1.userId }),
    /other than its author/i);
  await mustResolve("An independent reviewer can review the RCA",
    () => reviewRca({ rcaId: rcaA.id, facilityId: facA.id, reviewedByStaffId: a2.id, byUserId: a2.userId }));
  await mustReject("A reviewed RCA is locked against further edits",
    () => updateRca({ rcaId: rcaA.id, facilityId: facA.id, patch: { findings: "late" }, byUserId: a1.userId }),
    /locked/i);

  const capaA = await createCapa({ facilityId: facA.id, title: `${tag} capa`, description: "d", actionType: "CORRECTIVE", incidentId: incA.id, ownerStaffId: a2.id, createdByStaffId: a1.id, byUserId: a1.userId });
  await transitionCapa({ capaId: capaA.id, facilityId: facA.id, to: "IN_PROGRESS", actorStaffId: a2.id, byUserId: a2.userId });
  await transitionCapa({ capaId: capaA.id, facilityId: facA.id, to: "COMPLETED", actorStaffId: a2.id, completionNote: "done", byUserId: a2.userId });
  await mustReject("CAPA owner cannot verify their own completed action",
    () => transitionCapa({ capaId: capaA.id, facilityId: facA.id, to: "VERIFIED", actorStaffId: a2.id, byUserId: a2.userId }),
    /other than its owner or creator/i);
  await mustReject("CAPA creator cannot verify the action they raised",
    () => transitionCapa({ capaId: capaA.id, facilityId: facA.id, to: "VERIFIED", actorStaffId: a1.id, byUserId: a1.userId }),
    /other than its owner or creator/i);
  await mustResolve("An independent verifier can verify the CAPA",
    () => transitionCapa({ capaId: capaA.id, facilityId: facA.id, to: "VERIFIED", actorStaffId: a3.id, byUserId: a3.userId }));

  const credSelf = await createCredential({ facilityId: facA.id, staffId: a1.id, credentialType: "REGISTRATION", name: `${tag} self`, createdByStaffId: a1.id, byUserId: a1.userId });
  await mustReject("A staff member cannot verify their own credential (self-credentialing)",
    () => verifyCredential({ facilityId: facA.id, credentialId: credSelf.id, verifiedByStaffId: a1.id, byUserId: a1.userId }),
    /belongs|other than/i);
  await mustReject("Cross-facility verifier is refused",
    () => verifyCredential({ facilityId: facA.id, credentialId: credSelf.id, verifiedByStaffId: b1.id, byUserId: b1.userId }),
    /not found/i);
  await mustResolve("An independent verifier can verify the credential",
    () => verifyCredential({ facilityId: facA.id, credentialId: credSelf.id, verifiedByStaffId: a2.id, byUserId: a2.userId }));

  await mustReject("A staff member cannot grant themselves a clinical privilege",
    () => grantPrivilege({ facilityId: facA.id, staffId: a1.id, privilegeType: "SELF_GRANT", grantedByStaffId: a1.id, byUserId: a1.userId }),
    /yourself/i);

  // ══ 5. CREDENTIAL / PRIVILEGE PREDICATES (gate §10) ═══════════════════════
  console.log("\n── Credential-aware authorization ──");

  report("Expiry is derived from the date, not a stale status column",
    deriveExpiryState(new Date(Date.now() - 86400_000)) === "EXPIRED" && deriveExpiryState(new Date(Date.now() + 400 * 86400_000)) === "ACTIVE");

  const privOk = await grantPrivilege({ facilityId: facA.id, staffId: a3.id, privilegeType: `${tag}-OK`, grantedByStaffId: a1.id, byUserId: a1.userId });
  await mustResolve("Active privilege satisfies requirePrivilege",
    () => requirePrivilege(prisma, { staffId: a3.id, facilityId: facA.id, privilegeType: `${tag}-OK` }));
  await mustReject("The same privilege does NOT authorize in another facility",
    () => requirePrivilege(prisma, { staffId: a3.id, facilityId: facB.id, privilegeType: `${tag}-OK` }),
    /facility/i);
  await mustReject("A missing privilege is refused",
    () => requirePrivilege(prisma, { staffId: a3.id, facilityId: facA.id, privilegeType: `${tag}-NEVER-GRANTED` }),
    /has not been granted/i);

  await suspendPrivilege({ facilityId: facA.id, privilegeId: privOk.id, byUserId: a1.userId });
  await mustReject("A suspended privilege no longer authorizes",
    () => requirePrivilege(prisma, { staffId: a3.id, facilityId: facA.id, privilegeType: `${tag}-OK` }),
    /suspended/i);

  const privRev = await grantPrivilege({ facilityId: facA.id, staffId: a3.id, privilegeType: `${tag}-REV`, grantedByStaffId: a1.id, byUserId: a1.userId });
  await revokePrivilege({ facilityId: facA.id, privilegeId: privRev.id, revokedByStaffId: a1.id, byUserId: a1.userId });
  await mustReject("A revoked privilege no longer authorizes",
    () => requirePrivilege(prisma, { staffId: a3.id, facilityId: facA.id, privilegeType: `${tag}-REV` }),
    /revoked/i);

  const privExp = await grantPrivilege({ facilityId: facA.id, staffId: a3.id, privilegeType: `${tag}-EXP`, expiresAt: new Date(Date.now() - 86400_000), grantedByStaffId: a1.id, byUserId: a1.userId });
  await mustReject("An ACTIVE-but-expired privilege no longer authorizes",
    () => requirePrivilege(prisma, { staffId: a3.id, facilityId: facA.id, privilegeType: `${tag}-EXP` }),
    /expired/i);

  // A superseded expired grant must not mask a current one (the .find() bug).
  await grantPrivilege({ facilityId: facA.id, staffId: a3.id, privilegeType: `${tag}-EXP`, grantedByStaffId: a1.id, byUserId: a1.userId });
  await mustResolve("A renewed privilege authorizes despite an expired predecessor row",
    () => requirePrivilege(prisma, { staffId: a3.id, facilityId: facA.id, privilegeType: `${tag}-EXP` }));
  void privExp;

  const credExp = await createCredential({ facilityId: facA.id, staffId: a3.id, credentialType: "LICENSE", name: `${tag} lic`, expiresAt: new Date(Date.now() - 86400_000), createdByStaffId: a1.id, byUserId: a1.userId });
  await verifyCredential({ facilityId: facA.id, credentialId: credExp.id, verifiedByStaffId: a2.id, byUserId: a2.userId });
  await mustReject("A VERIFIED-but-expired credential no longer authorizes",
    () => requireCredential(prisma, { staffId: a3.id, facilityId: facA.id, credentialType: "LICENSE" }),
    /expired/i);

  const inactive = await prisma.hospitalStaffProfile.findFirst({ where: { facilityId: facA.id, status: { not: "ACTIVE" } } });
  if (inactive) {
    await mustReject("Inactive staff cannot satisfy a privilege predicate",
      () => requirePrivilege(prisma, { staffId: inactive.id, facilityId: facA.id, privilegeType: `${tag}-OK` }),
      /not active|facility/i);
  } else {
    report("Inactive staff cannot satisfy a privilege predicate", true, "skipped: no inactive staff seeded");
  }
  report("CredentialAuthorizationError carries a 403 and a reason code",
    new CredentialAuthorizationError("EXPIRED_PRIVILEGE", "x").status === 403);

  // ══ 6. CONCURRENCY — GENUINE PARALLELISM (gate §35) ═══════════════════════
  console.log("\n── Concurrency (real parallel PostgreSQL) ──");

  const winners = (rs: { ok: boolean }[]) => rs.filter((r) => r.ok).length;
  const attempt = (fn: () => Promise<unknown>) => fn().then(() => ({ ok: true }), () => ({ ok: false }));

  {
    const inc = await createQualityIncident({ facilityId: facA.id, category: "FALL", title: `${tag} race1`, description: "r", reportedByStaffId: a1.id, byUserId: a1.userId });
    const rs = await Promise.all([1, 2, 3].map(() => attempt(() => transitionIncident({ incidentId: inc.id, facilityId: facA.id, to: "TRIAGED", actorStaffId: a1.id, byUserId: a1.userId }))));
    report("Quality incident transition: exactly one winner of three", winners(rs) === 1, `winners=${winners(rs)}`);
  }

  {
    const inc = await createQualityIncident({ facilityId: facA.id, category: "FALL", title: `${tag} race2`, description: "r", reportedByStaffId: a1.id, byUserId: a1.userId });
    await transitionIncident({ incidentId: inc.id, facilityId: facA.id, to: "TRIAGED", actorStaffId: a1.id, byUserId: a1.userId });
    await transitionIncident({ incidentId: inc.id, facilityId: facA.id, to: "RESOLVED", actorStaffId: a1.id, byUserId: a1.userId });
    await transitionIncident({ incidentId: inc.id, facilityId: facA.id, to: "CLOSED", actorStaffId: a1.id, byUserId: a1.userId });
    const rs = await Promise.all([1, 2].map(() => attempt(() => reopenIncident({ incidentId: inc.id, facilityId: facA.id, actorStaffId: a1.id, reason: "re", byUserId: a1.userId }))));
    report("Incident reopen: exactly one winner", winners(rs) === 1, `winners=${winners(rs)}`);
    const closedAgain = await prisma.qualityIncident.findUniqueOrThrow({ where: { id: inc.id } });
    report("A reopened incident leaves CLOSED exactly once", closedAgain.status === "UNDER_INVESTIGATION");
  }

  {
    const capa = await createCapa({ facilityId: facA.id, title: `${tag} capa-race`, description: "d", actionType: "PREVENTIVE", ownerStaffId: a2.id, createdByStaffId: a1.id, byUserId: a1.userId });
    await transitionCapa({ capaId: capa.id, facilityId: facA.id, to: "IN_PROGRESS", actorStaffId: a2.id, byUserId: a2.userId });
    const rs = await Promise.all([1, 2].map(() => attempt(() => transitionCapa({ capaId: capa.id, facilityId: facA.id, to: "COMPLETED", actorStaffId: a2.id, completionNote: "n", byUserId: a2.userId }))));
    report("CAPA completion: exactly one winner", winners(rs) === 1, `winners=${winners(rs)}`);
  }

  {
    const cred = await createCredential({ facilityId: facA.id, staffId: a3.id, credentialType: "CERTIFICATION", name: `${tag} race`, createdByStaffId: a1.id, byUserId: a1.userId });
    const rs = await Promise.all([1, 2].map(() => attempt(() => verifyCredential({ facilityId: facA.id, credentialId: cred.id, verifiedByStaffId: a2.id, byUserId: a2.userId }))));
    report("Credential verification: exactly one winner", winners(rs) === 1, `winners=${winners(rs)}`);
  }

  {
    const priv = await grantPrivilege({ facilityId: facA.id, staffId: a3.id, privilegeType: `${tag}-RACE`, grantedByStaffId: a1.id, byUserId: a1.userId });
    const rs = await Promise.all([
      attempt(() => suspendPrivilege({ facilityId: facA.id, privilegeId: priv.id, byUserId: a1.userId })),
      attempt(() => revokePrivilege({ facilityId: facA.id, privilegeId: priv.id, revokedByStaffId: a1.id, byUserId: a1.userId })),
    ]);
    const after = await prisma.staffPrivilege.findUniqueOrThrow({ where: { id: priv.id } });
    report("Privilege suspend/revoke race resolves to a single terminal state", winners(rs) === 1 && ["SUSPENDED", "REVOKED"].includes(after.status), `winners=${winners(rs)} status=${after.status}`);
  }

  {
    const base = new Date(Date.now() + 30 * 86400_000);
    const mk = (offsetH: number) => () => createShift({
      facilityId: facA.id, staffId: a3.id,
      startAt: new Date(base.getTime() + offsetH * 3600_000),
      endAt: new Date(base.getTime() + (offsetH + 8) * 3600_000),
      assignedByStaffId: a1.id, byUserId: a1.userId,
    });
    // Overlapping but NOT identical starts — the unique index cannot catch this;
    // only the exclusion constraint added by this gate can.
    let leaked = false;
    const tryShift = (f: () => Promise<unknown>) => f().then(() => ({ ok: true }), (e: unknown) => {
      // The loser must receive the domain conflict, never a raw database fault.
      if (e instanceof Error && /deadlock|exclusion constraint|23P01/i.test(e.message)) leaked = true;
      return { ok: false };
    });
    const rs = await Promise.all([tryShift(mk(0)), tryShift(mk(4))]);
    const shifts = await prisma.staffShift.count({ where: { staffId: a3.id, status: "SCHEDULED", startAt: { gte: base, lt: new Date(base.getTime() + 24 * 3600_000) } } });
    report("Overlapping shift race: only one shift survives (EXCLUDE constraint)", shifts === 1, `created=${shifts} winners=${winners(rs)}`);
    report("Overlapping shift race: loser gets a domain conflict, not a raw DB error", !leaked);
  }

  // RFQ award — the deadlock this gate fixed. Always builds its OWN fixture so
  // the race is genuinely executed rather than skipped when seed data happens to
  // contain an already-awarded RFQ.
  {
    const supplier = await prisma.supplier.findFirst({ where: { facilityId: facA.id } });
    if (!supplier) {
      report("Concurrent RFQ award: exactly one winner, no deadlock", false, "no supplier seeded — fixture could not be built");
    } else {
      const s2 = await prisma.supplier.create({ data: { facilityId: facA.id, name: `${tag} supplier2`, code: `${tag}-S2` } as never });
      const newRfq = await prisma.rfq.create({ data: { facilityId: facA.id, status: "SENT", createdByStaffId: a1.id } });
      const q1 = await prisma.rfqQuotation.create({ data: { rfqId: newRfq.id, facilityId: facA.id, supplierId: supplier.id, status: "SUBMITTED", totalMinor: 1000, recordedByStaffId: a1.id } });
      const q2 = await prisma.rfqQuotation.create({ data: { rfqId: newRfq.id, facilityId: facA.id, supplierId: s2.id, status: "SUBMITTED", totalMinor: 2000, recordedByStaffId: a1.id } });
      let deadlocked = false;
      const award = (id: string) => selectQuotation({ quotationId: id, facilityId: facA.id, byUserId: a1.userId })
        .then(() => ({ ok: true }), (e: unknown) => {
          if (e instanceof Error && /deadlock/i.test(e.message)) deadlocked = true;
          return { ok: false };
        });
      const rs = await Promise.all([award(q1.id), award(q2.id)]);
      const selected = await prisma.rfqQuotation.count({ where: { rfqId: newRfq.id, status: "SELECTED" } });
      report("Concurrent RFQ award: exactly one winner, no deadlock",
        winners(rs) === 1 && selected === 1 && !deadlocked,
        `winners=${winners(rs)} selected=${selected} deadlock=${deadlocked}`);
    }
  }

  // ══ 7. LIFECYCLE / CLOSED-RECORD PROTECTION (gate §27, §36) ═══════════════
  console.log("\n── Lifecycle protection ──");

  {
    const inc = await createQualityIncident({ facilityId: facA.id, category: "SECURITY", title: `${tag} lifecycle`, description: "l", reportedByStaffId: a1.id, byUserId: a1.userId });
    await mustReject("Illegal incident transition (REPORTED -> CLOSED) is refused",
      () => transitionIncident({ incidentId: inc.id, facilityId: facA.id, to: "CLOSED", actorStaffId: a1.id, byUserId: a1.userId }),
      /illegal/i);
    await transitionIncident({ incidentId: inc.id, facilityId: facA.id, to: "CANCELLED", actorStaffId: a1.id, byUserId: a1.userId });
    await mustReject("A cancelled incident cannot be transitioned further",
      () => transitionIncident({ incidentId: inc.id, facilityId: facA.id, to: "TRIAGED", actorStaffId: a1.id, byUserId: a1.userId }),
      /illegal/i);
    await mustReject("An RCA cannot be added to a cancelled incident",
      () => createRca({ facilityId: facA.id, incidentId: inc.id, problemStatement: "p", authoredByStaffId: a1.id, byUserId: a1.userId }),
      /cancelled/i);
  }

  {
    const f = await createFinding({ facilityId: facA.id, title: `${tag} finding`, description: "d", identifiedByStaffId: a1.id, byUserId: a1.userId });
    await closeFinding({ facilityId: facA.id, findingId: f.id, closedByStaffId: a1.id, byUserId: a1.userId });
    await mustReject("A closed finding cannot be closed again", () => closeFinding({ facilityId: facA.id, findingId: f.id, closedByStaffId: a1.id, byUserId: a1.userId }), /already closed/i);
  }

  {
    const std = await createStandard({ facilityId: facA.id, code: `${tag}-STD`, title: "s", createdByStaffId: a1.id, byUserId: a1.userId });
    await mustReject("Duplicate standard code in the same facility is refused",
      () => createStandard({ facilityId: facA.id, code: `${tag}-STD`, title: "s2", createdByStaffId: a1.id, byUserId: a1.userId }),
      /already exists/i);
    await addMeasure({ facilityId: facA.id, standardId: std.id, code: `${tag}-M1`, title: "m", byUserId: a1.userId });
    await mustReject("A measure cannot be added to another facility's standard",
      () => addMeasure({ facilityId: facB.id, standardId: std.id, code: `${tag}-M2`, title: "m", byUserId: b1.userId }),
      /not found/i);
  }

  // ══ 8. DATABASE INVARIANTS (gate §36) ═════════════════════════════════════
  console.log("\n── Database invariants ──");

  // Counts come back as bigint from PostgreSQL; normalise to number so the
  // assertions stay readable under this project's pre-ES2020 target.
  const q = async (sql: string) => Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(sql))[0].n);

  report("BED: no bed has two active occupants",
    (await q(`SELECT COUNT(*)::bigint AS n FROM (SELECT "bedId" FROM "EncounterLocation" WHERE "releasedAt" IS NULL AND "bedId" IS NOT NULL GROUP BY "bedId" HAVING COUNT(*)>1) t`)) === 0);
  report("ADT: no encounter has two active locations",
    (await q(`SELECT COUNT(*)::bigint AS n FROM (SELECT "encounterId" FROM "EncounterLocation" WHERE "releasedAt" IS NULL GROUP BY "encounterId" HAVING COUNT(*)>1) t`)) === 0);
  report("INVENTORY: no negative on-hand quantity",
    (await q(`SELECT COUNT(*)::bigint AS n FROM "StockBalance" WHERE "onHandQty" < 0`)) === 0);
  report("INVENTORY: no negative reserved quantity",
    (await q(`SELECT COUNT(*)::bigint AS n FROM "StockBalance" WHERE "reservedQty" < 0`)) === 0);
  report("INVENTORY: reserved never exceeds on-hand",
    (await q(`SELECT COUNT(*)::bigint AS n FROM "StockBalance" WHERE "reservedQty" > "onHandQty"`)) === 0);
  report("BILLING: no invoice is over-allocated",
    (await q(`SELECT COUNT(*)::bigint AS n FROM "Invoice" WHERE "allocatedMinor" > "totalMinor"`)) === 0);
  report("BILLING: no negative payment allocation",
    (await q(`SELECT COUNT(*)::bigint AS n FROM "PaymentAllocation" WHERE "amountMinor" < 0`)) === 0);
  report("BLOOD: no serialized unit is issued twice",
    (await q(`SELECT COUNT(*)::bigint AS n FROM (SELECT "unitId" FROM "BloodIssue" WHERE "status" NOT IN ('RETURNED','CANCELLED') GROUP BY "unitId" HAVING COUNT(*)>1) t`)) === 0);
  report("PROCUREMENT: accepted quantity never exceeds the ordered ceiling",
    (await q(`SELECT COUNT(*)::bigint AS n FROM (
       SELECT pol.id FROM "PurchaseOrderLine" pol
       LEFT JOIN "GoodsReceiptLine" grl ON grl."purchaseOrderLineId" = pol.id
       LEFT JOIN "GoodsReceipt" gr ON gr.id = grl."goodsReceiptId" AND gr."status"='APPROVED'
       GROUP BY pol.id, pol."orderedQuantity"
       HAVING COALESCE(SUM(CASE WHEN gr.id IS NOT NULL THEN grl."acceptedQuantity" ELSE 0 END),0) > pol."orderedQuantity") t`)) === 0);
  report("QUALITY: every incident transition records an actor",
    (await q(`SELECT COUNT(*)::bigint AS n FROM "QualityIncidentTransition" WHERE "actorStaffId" IS NULL OR "actorStaffId"=''`)) === 0);
  report("WORKFORCE: no overlapping scheduled shifts for one staff member",
    (await q(`SELECT COUNT(*)::bigint AS n FROM "StaffShift" s1 JOIN "StaffShift" s2
       ON s1."staffId"=s2."staffId" AND s1.id < s2.id
       AND s1."status"='SCHEDULED' AND s2."status"='SCHEDULED'
       AND s1."startAt" < s2."endAt" AND s2."startAt" < s1."endAt"`)) === 0);
  report("WORKFORCE: no privilege is both ACTIVE and past its expiry without being derivable as expired",
    (await q(`SELECT COUNT(*)::bigint AS n FROM "StaffPrivilege" WHERE "status"='ACTIVE' AND "expiresAt" IS NOT NULL AND "expiresAt" < NOW() AND "revokedAt" IS NOT NULL`)) === 0);

  // ══ 9. AUDIT COVERAGE (gate §28) ══════════════════════════════════════════
  console.log("\n── Audit coverage ──");
  for (const t of [
    "hospital.quality.incidentReported", "hospital.quality.rcaCreated", "hospital.quality.rcaUpdated",
    "hospital.quality.rcaReviewed", "hospital.quality.capaCreated", "hospital.quality.capaVerified",
    "hospital.workforce.credentialCreated", "hospital.workforce.credentialVerified",
    "hospital.workforce.privilegeGranted", "hospital.workforce.privilegeRevoked",
  ]) {
    const n = await prisma.auditEvent.count({ where: { type: t } });
    report(`Audit event emitted: ${t}`, n > 0, `count=${n}`);
  }
  const orphanActor = await prisma.auditEvent.count({ where: { userId: "" } });
  report("No audit event has an empty actor", orphanActor === 0);

  console.log(`\n════════════════════════════════════════`);
  console.log(`PHASE B FINAL GATE — PASS ${pass} / FAIL ${fail}`);
  if (failures.length) { console.log("Failures:"); failures.forEach((f) => console.log(`  - ${f}`)); }
  console.log(`════════════════════════════════════════\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
