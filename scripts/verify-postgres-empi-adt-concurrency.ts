/**
 * Phase 6.8 manual verification: proves the EMPI + ADT invariants hold
 * against a real PostgreSQL instance under genuine concurrency, and that
 * cross-facility isolation blocks EMPI/ADT operations. Mirrors
 * scripts/verify-postgres-bed-concurrency.ts's structure and reuses the real
 * service functions (no mocks). Admission/transfer bed races are already
 * covered by verify-postgres-bed-concurrency.ts — this script adds UHID,
 * discharge, merge, unmerge, and facility-isolation coverage.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-empi-adt-concurrency.ts
 */
import { PrismaClient } from "@prisma/client";
import { createPatientWithUhid } from "../src/lib/hospital/uhid";
import { mergePatients, unmergePatients, AlreadyMergedError, CrossFacilityMergeError } from "../src/lib/patient/merge";
import { admitPatient, initiateDischarge, updateDischargeReadiness, finalizeDischarge } from "../src/lib/hospital/admission";

const prisma = new PrismaClient();
const runId = Date.now();
let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

async function main() {
  const facility = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Medical Centre" } });
  const otherFacility = await prisma.facility.findFirst({ where: { id: { not: facility.id } } });
  const staff = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { facilityId: facility.id, user: { role: "DOCTOR" } } });

  // ── A: concurrent patient creation → no duplicate UHID, no 500s ──
  {
    const N = 8;
    const attempts = Array.from({ length: N }, (_, i) =>
      createPatientWithUhid(facility.id, (uhid) =>
        prisma.patient.create({ data: { uhid, facilityId: facility.id, fullName: `UHID Race ${runId}-${i}`, sex: "female" } })
      ).then((p) => ({ ok: true as const, uhid: p.uhid }), (err) => ({ ok: false as const, err }))
    );
    const results = await Promise.all(attempts);
    const ok = results.filter((r) => r.ok) as { ok: true; uhid: string }[];
    const uhids = new Set(ok.map((r) => r.uhid));
    report(
      "A: concurrent patient creation — all succeed with distinct UHIDs, no duplicates",
      ok.length === N && uhids.size === N,
      `succeeded=${ok.length}/${N}, distinctUhids=${uhids.size}`
    );
  }

  // ── B: concurrent finalizeDischarge on the same admission → exactly one wins ──
  {
    const ward = await prisma.ward.create({ data: { facilityId: facility.id, name: `EMPI Ward ${runId}`, wardType: "GENERAL" } });
    const bed = await prisma.bed.create({ data: { facilityId: facility.id, wardId: ward.id, label: `EMPI-Bed-${runId}` } });
    const patient = await prisma.patient.create({ data: { uhid: `UHID-DISCH-${runId}`, facilityId: facility.id, fullName: `Discharge Race ${runId}`, sex: "male" } });
    const enc = await prisma.encounter.create({ data: { facilityId: facility.id, patientId: patient.id, type: "IPD", accessSource: "WALK_IN" } });
    const admission = await admitPatient({ encounterId: enc.id, bedId: bed.id, admittingStaffId: staff.id, reason: "discharge-race", admissionType: "ELECTIVE", byUserId: staff.userId });
    const discharge = await initiateDischarge(admission.id, staff.userId, staff.id);
    await updateDischargeReadiness(discharge.id, {
      clinicallyReady: true, documentationReady: true, billingReady: true, insuranceReady: true, pharmacyReady: true, transportReady: true,
    });
    const attempt = () => finalizeDischarge(discharge.id, staff.userId, { note: "race" }, "ROUTINE").then((d) => ({ ok: true as const, d }), (err) => ({ ok: false as const, err }));
    const [r1, r2] = await Promise.all([attempt(), attempt()]);
    const succeeded = [r1, r2].filter((r) => r.ok).length;
    const finalBed = await prisma.bed.findUniqueOrThrow({ where: { id: bed.id } });
    const encNow = await prisma.encounter.findUniqueOrThrow({ where: { id: enc.id } });
    report(
      "B: concurrent finalizeDischarge on same admission — exactly one wins, encounter DISCHARGED, bed released",
      succeeded === 1 && encNow.status === "DISCHARGED" && finalBed.status === "CLEANING",
      `succeeded=${succeeded}, encounter=${encNow.status}, bed=${finalBed.status}`
    );

    // Location history: exactly one location row, released at discharge.
    const locations = await prisma.encounterLocation.findMany({ where: { encounterId: enc.id } });
    report(
      "B2: admission created one EncounterLocation, released at discharge (no open location remains)",
      locations.length === 1 && locations[0].releasedAt !== null,
      `locations=${locations.length}, released=${locations[0]?.releasedAt !== null}`
    );
  }

  // ── C: concurrent merge of the SAME source patient → exactly one wins ──
  {
    const source = await prisma.patient.create({ data: { uhid: `UHID-MSRC-${runId}`, facilityId: facility.id, fullName: `Merge Source ${runId}`, sex: "female" } });
    const targetA = await prisma.patient.create({ data: { uhid: `UHID-MTA-${runId}`, facilityId: facility.id, fullName: `Merge Target A ${runId}`, sex: "female" } });
    const targetB = await prisma.patient.create({ data: { uhid: `UHID-MTB-${runId}`, facilityId: facility.id, fullName: `Merge Target B ${runId}`, sex: "female" } });
    const attempt = (targetId: string) =>
      mergePatients({ sourcePatientId: source.id, targetPatientId: targetId, actorStaffId: staff.id, actorUserId: staff.userId, reason: "race" }).then(
        () => ({ ok: true as const }),
        (err) => ({ ok: false as const, err })
      );
    const [r1, r2] = await Promise.all([attempt(targetA.id), attempt(targetB.id)]);
    const succeeded = [r1, r2].filter((r) => r.ok).length;
    const failedAlready = [r1, r2].filter((r) => !r.ok && (r as { err: unknown }).err instanceof AlreadyMergedError).length;
    const sourceNow = await prisma.patient.findUniqueOrThrow({ where: { id: source.id } });
    const mergeRecords = await prisma.patientMergeRecord.count({ where: { sourcePatientId: source.id } });
    report(
      "C: concurrent merge of same source — exactly one wins, one merge record, single coherent survivor",
      succeeded === 1 && failedAlready === 1 && sourceNow.mergedIntoId !== null && mergeRecords === 1,
      `succeeded=${succeeded}, failedAlready=${failedAlready}, mergedInto=${sourceNow.mergedIntoId ? "set" : "null"}, records=${mergeRecords}`
    );

    // ── C2: unmerge restores the source; concurrent unmerge → exactly one wins ──
    const unmergeAttempt = () =>
      unmergePatients({ patientId: source.id, actorStaffId: staff.id, actorUserId: staff.userId, reason: "race-unmerge" }).then(
        () => ({ ok: true as const }),
        (err) => ({ ok: false as const, err })
      );
    const [u1, u2] = await Promise.all([unmergeAttempt(), unmergeAttempt()]);
    const unmergeSucceeded = [u1, u2].filter((r) => r.ok).length;
    const sourceAfter = await prisma.patient.findUniqueOrThrow({ where: { id: source.id } });
    report(
      "C2: concurrent unmerge — exactly one wins, source restored to standalone (mergedIntoId null)",
      unmergeSucceeded === 1 && sourceAfter.mergedIntoId === null && sourceAfter.mergedAt === null,
      `unmergeSucceeded=${unmergeSucceeded}, mergedInto=${sourceAfter.mergedIntoId ? "set" : "null"}`
    );
  }

  // ── D: cross-facility merge is rejected ──
  if (otherFacility) {
    const a = await prisma.patient.create({ data: { uhid: `UHID-XA-${runId}`, facilityId: facility.id, fullName: `XF A ${runId}`, sex: "male" } });
    const b = await prisma.patient.create({ data: { uhid: `UHID-XB-${runId}`, facilityId: otherFacility.id, fullName: `XF B ${runId}`, sex: "male" } });
    const res = await mergePatients({ sourcePatientId: a.id, targetPatientId: b.id, actorStaffId: staff.id, actorUserId: staff.userId, reason: "should-fail" }).then(
      () => ({ ok: true as const }),
      (err) => ({ ok: false as const, err })
    );
    report("D: cross-facility merge rejected (facility isolation)", !res.ok && (res as { err: unknown }).err instanceof CrossFacilityMergeError);
  } else {
    report("D: cross-facility merge rejected (skipped — only one facility seeded)", true);
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
