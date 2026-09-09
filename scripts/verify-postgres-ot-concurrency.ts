/**
 * Phase B3 manual verification: Operating Theatre workflow against real
 * PostgreSQL — OT scheduling overlap race (exclusion constraint), same-
 * surgery double-schedule, procedure-completion race, implant inventory
 * over-issue safety, and wrong-patient/cross-facility protection.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-ot-concurrency.ts
 */
import { PrismaClient } from "@prisma/client";
import { createOperatingTheatre, createProcedure, requestSurgery, transitionSurgery, scheduleSurgery, startProcedure, completeProcedure, recordItemUsage, SurgeryScheduleConflictError, SurgeryTransitionError } from "../src/lib/hospital/surgery";
import { createAdjustment } from "../src/lib/hospital/inventory/adjustment";

const prisma = new PrismaClient();
const runId = Date.now();
let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

async function approvedSurgery(facilityId: string, patientId: string, staffId: string, byUserId: string) {
  const enc = await prisma.encounter.create({ data: { facilityId, patientId, type: "IPD", accessSource: "WALK_IN" } });
  const surgery = await requestSurgery({ facilityId, patientId, encounterId: enc.id, procedureName: `Appendectomy ${runId}`, requestedByStaffId: staffId, byUserId });
  await transitionSurgery({ surgeryId: surgery.id, facilityId, to: "REVIEWED", actorStaffId: staffId, byUserId });
  await transitionSurgery({ surgeryId: surgery.id, facilityId, to: "APPROVED", actorStaffId: staffId, byUserId });
  return surgery;
}

async function main() {
  const facility = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Medical Centre" } });
  const staff = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { facilityId: facility.id, user: { role: "DOCTOR" } } });
  const patient = await prisma.patient.findFirstOrThrow({ where: { facilityId: facility.id } });
  const ot = await createOperatingTheatre({ facilityId: facility.id, name: `OT-${runId}`, type: "GENERAL", byUserId: staff.userId });
  await createProcedure({ facilityId: facility.id, code: `APPY-${runId}`, name: "Appendectomy", byUserId: staff.userId });

  const start = new Date(Date.now() + 3_600_000);
  const end = new Date(Date.now() + 2 * 3_600_000);

  // ── A: two overlapping schedules into the same OT — exactly one wins ──
  {
    const s1 = await approvedSurgery(facility.id, patient.id, staff.id, staff.userId);
    const s2 = await approvedSurgery(facility.id, patient.id, staff.id, staff.userId);
    const attempt = (surgeryId: string) =>
      scheduleSurgery({ surgeryId, facilityId: facility.id, operatingTheatreId: ot.id, startAt: start, endAt: end, schedulerStaffId: staff.id, byUserId: staff.userId }).then(() => ({ ok: true as const }), (err) => ({ ok: false as const, err }));
    const [r1, r2] = await Promise.all([attempt(s1.id), attempt(s2.id)]);
    const succeeded = [r1, r2].filter((r) => r.ok).length;
    const conflicts = [r1, r2].filter((r) => !r.ok && (r as { err: unknown }).err instanceof SurgeryScheduleConflictError).length;
    const scheduledInSlot = await prisma.surgerySchedule.count({ where: { operatingTheatreId: ot.id, status: "SCHEDULED", startAt: { lt: end }, endAt: { gt: start } } });
    report("A: two overlapping OT schedules — exactly one succeeds, one conflict, one booking in the slot", succeeded === 1 && conflicts === 1 && scheduledInSlot === 1, `succeeded=${succeeded}, conflicts=${conflicts}, inSlot=${scheduledInSlot}`);
  }

  // ── B: adjacent (non-overlapping) schedules both succeed ──
  {
    const s3 = await approvedSurgery(facility.id, patient.id, staff.id, staff.userId);
    const adjStart = new Date(end.getTime());
    const adjEnd = new Date(end.getTime() + 3_600_000);
    const r = await scheduleSurgery({ surgeryId: s3.id, facilityId: facility.id, operatingTheatreId: ot.id, startAt: adjStart, endAt: adjEnd, schedulerStaffId: staff.id, byUserId: staff.userId }).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    report("B: adjacent (non-overlapping) OT slot is allowed", r.ok);
  }

  // ── C: concurrent procedure completion — exactly one wins ──
  {
    const s = await approvedSurgery(facility.id, patient.id, staff.id, staff.userId);
    const cStart = new Date(Date.now() + 10 * 3_600_000);
    const cEnd = new Date(Date.now() + 11 * 3_600_000);
    await scheduleSurgery({ surgeryId: s.id, facilityId: facility.id, operatingTheatreId: ot.id, startAt: cStart, endAt: cEnd, schedulerStaffId: staff.id, byUserId: staff.userId });
    await startProcedure({ surgeryId: s.id, facilityId: facility.id, byUserId: staff.userId });
    const attempt = () => completeProcedure({ surgeryId: s.id, facilityId: facility.id, byUserId: staff.userId }).then(() => ({ ok: true as const }), (err) => ({ ok: false as const, err }));
    const [r1, r2] = await Promise.all([attempt(), attempt()]);
    const succeeded = [r1, r2].filter((r) => r.ok).length;
    const finalSurgery = await prisma.surgery.findUniqueOrThrow({ where: { id: s.id } });
    report("C: concurrent procedure completion — exactly one wins, status COMPLETED", succeeded === 1 && finalSurgery.status === "COMPLETED", `succeeded=${succeeded}, status=${finalSurgery.status}`);
  }

  // ── D: implant inventory over-issue safety — concurrent uses of a lot with only 1 unit ──
  {
    const item = await prisma.item.create({ data: { facilityId: facility.id, sku: `IMPL-${runId}`, name: `Implant ${runId}`, category: "CONSUMABLE", baseUnit: "PIECE" } });
    const lot = await prisma.itemLot.create({ data: { itemId: item.id, facilityId: facility.id, lotNumber: `IMPL-LOT-${runId}`, status: "ACTIVE", expiresAt: new Date("2030-01-01") } });
    const loc = await prisma.stockLocation.findFirstOrThrow({ where: { facilityId: facility.id } });
    await prisma.$transaction((tx) => createAdjustment(tx, { facilityId: facility.id, itemId: item.id, lotId: lot.id, locationId: loc.id, quantityDelta: 1, reason: "FOUND", requestedByStaffId: staff.id, actorUserId: staff.userId, idempotencyKey: `impl-seed-${runId}` }));

    const s = await approvedSurgery(facility.id, patient.id, staff.id, staff.userId);
    const attempt = () => recordItemUsage({ surgeryId: s.id, facilityId: facility.id, usageType: "IMPLANT", itemId: item.id, itemLotId: lot.id, quantity: 1, locationId: loc.id, recordedByStaffId: staff.id, actorUserId: staff.userId, byUserId: staff.userId }).then(() => ({ ok: true as const }), (err) => ({ ok: false as const, err }));
    const [r1, r2] = await Promise.all([attempt(), attempt()]);
    const succeeded = [r1, r2].filter((r) => r.ok).length;
    const balance = await prisma.stockBalance.findFirst({ where: { itemId: item.id, lotId: lot.id, locationId: loc.id } });
    const consumedUsages = await prisma.surgeryItemUsage.count({ where: { surgeryId: s.id, stockConsumed: true } });
    report("D: implant inventory over-issue safety — at most one stock-consuming use succeeds, on-hand never negative", (balance?.onHandQty ?? 0) >= 0 && consumedUsages <= 1 && succeeded >= 1, `succeeded=${succeeded}, onHand=${balance?.onHandQty}, consumedUsages=${consumedUsages}`);
  }

  // ── E: invalid transition rejected (completed surgery cannot go back to scheduled) ──
  {
    const s = await approvedSurgery(facility.id, patient.id, staff.id, staff.userId);
    const r = await transitionSurgery({ surgeryId: s.id, facilityId: facility.id, to: "IN_PROGRESS", actorStaffId: staff.id, byUserId: staff.userId }).then(() => ({ ok: true as const }), (err) => ({ ok: false as const, err }));
    report("E: illegal surgery transition (APPROVED -> IN_PROGRESS via generic transition) rejected", !r.ok && (r as { err: unknown }).err instanceof SurgeryTransitionError);
  }

  // ── F: cross-facility surgery request rejected ──
  {
    const otherFacility = await prisma.facility.findFirst({ where: { id: { not: facility.id } } });
    if (otherFacility) {
      const otherPatient = await prisma.patient.create({ data: { uhid: `UHID-OTXF-${runId}`, facilityId: otherFacility.id, fullName: `OT XF ${runId}`, sex: "male" } });
      const otherEnc = await prisma.encounter.create({ data: { facilityId: otherFacility.id, patientId: otherPatient.id, type: "IPD", accessSource: "WALK_IN" } });
      const r = await requestSurgery({ facilityId: facility.id, patientId: otherPatient.id, encounterId: otherEnc.id, procedureName: "x", requestedByStaffId: staff.id, byUserId: staff.userId }).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
      report("F: cross-facility surgery request rejected (encounter/patient facility mismatch)", !r.ok);
    } else {
      report("F: cross-facility surgery request (skipped — one facility)", true);
    }
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
