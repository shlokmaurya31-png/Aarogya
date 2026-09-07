/**
 * Phase 6.6 P0-C verification: proves administerMedication cannot
 * double-record the same scheduled dose under genuine concurrent
 * PostgreSQL transactions, now that it uses the guarded-updateMany CAS
 * idiom (status: "DUE" in the WHERE, count-checked) instead of a plain
 * read-then-write. Mirrors scripts/verify-postgres-billing-concurrency.ts's
 * structure — this codebase has no automated DB-backed test harness;
 * concurrency is verified via real parallel execution, by established
 * convention.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-medication-concurrency.ts
 */
import { PrismaClient } from "@prisma/client";
import {
  createMedicationOrder,
  verifyMedicationOrder,
  dispenseMedication,
  administerMedication,
  AdministrationNotDueError,
  MedicationOrderNotActiveError,
} from "../src/lib/hospital/medicationLifecycle";
import { linkMedicationToItem } from "../src/lib/hospital/inventory/itemMedicationLink";
import { createAdjustment } from "../src/lib/hospital/inventory/adjustment";
import { generateAdministrationSchedule } from "../src/lib/hospital/medicationSchedule";

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
  const doctor = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { facilityId: facility.id, user: { role: "DOCTOR" } } });
  const nurse = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { facilityId: facility.id, user: { role: "NURSE" } } });
  const pharmacist = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { facilityId: facility.id, user: { role: "PHARMACIST" } } });
  const encounter = await prisma.encounter.findFirstOrThrow({ where: { facilityId: facility.id } });
  const pharmacy = await prisma.stockLocation.findFirstOrThrow({ where: { facilityId: facility.id, name: "Central Pharmacy" } });

  // Build one real ACTIVE, dispensed medication order with 6 DUE scheduled
  // doses (reuses the P0-A fix's real link-creation path — this is a
  // genuine dispensed order, not a synthetic administration row).
  const drugName = `P0CRaceDrug${runId}`;
  const item = await prisma.item.create({ data: { facilityId: facility.id, sku: `P0C-RACE-${runId}`, name: drugName, category: "MEDICATION", baseUnit: "TABLET" } });
  await prisma.$transaction((tx) => linkMedicationToItem(tx, { facilityId: facility.id, drugName, itemId: item.id }));
  const lot = await prisma.itemLot.create({ data: { itemId: item.id, facilityId: facility.id, lotNumber: `P0C-RACE-LOT-${runId}`, status: "ACTIVE", expiresAt: new Date("2028-01-01") } });
  await prisma.$transaction((tx) =>
    createAdjustment(tx, { facilityId: facility.id, itemId: item.id, lotId: lot.id, locationId: pharmacy.id, quantityDelta: 20, reason: "FOUND", requestedByStaffId: pharmacist.id, actorUserId: pharmacist.userId, idempotencyKey: `p0c-seed-${runId}` })
  );

  const created = await createMedicationOrder({
    facilityId: facility.id,
    encounterId: encounter.id,
    patientId: encounter.patientId,
    orderingStaffId: doctor.id,
    drugName,
    dose: "1 tablet",
    route: "PO",
    frequency: "QID",
    byUserId: doctor.userId,
  });
  if (created.blocked) throw new Error("Unexpected safety block in fixture.");
  await verifyMedicationOrder(created.order.id, pharmacist.id, pharmacist.userId);
  await dispenseMedication({ medicationOrderId: created.order.id, pharmacistStaffId: pharmacist.id, quantity: 4, quantityUnit: "TABLET", dispensingLocationId: pharmacy.id, byUserId: pharmacist.userId });
  // 6 extra DUE slots, on top of the 3 auto-generated at order creation — enough for every case below without cross-contamination.
  await generateAdministrationSchedule(created.order.id, "QID", 6);
  const dueRows = await prisma.medicationAdministration.findMany({ where: { medicationOrderId: created.order.id, status: "DUE" }, orderBy: { scheduledAt: "asc" } });
  if (dueRows.length < 6) throw new Error(`Expected at least 6 DUE rows, got ${dueRows.length}`);

  // Case A: two concurrent requests to administer the SAME scheduled dose -> exactly one success, one AdministrationNotDueError, exactly one clinical record.
  {
    const target = dueRows[0];
    const attempt = () => administerMedication({ administrationId: target.id, status: "GIVEN", administeredByStaffId: nurse.id, safetyChecksConfirmed: true, byUserId: nurse.userId });
    const results = await Promise.allSettled([attempt(), attempt()]);
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failedNotDue = results.filter((r) => r.status === "rejected" && r.reason instanceof AdministrationNotDueError).length;
    const finalRow = await prisma.medicationAdministration.findUniqueOrThrow({ where: { id: target.id } });
    report(
      "CASE A: two concurrent requests for the SAME scheduled dose — exactly one succeeds, one rejected, exactly one GIVEN record",
      succeeded === 1 && failedNotDue === 1 && finalRow.status === "GIVEN",
      `succeeded=${succeeded}, failedNotDue=${failedNotDue}, finalStatus=${finalRow.status}`
    );
  }

  // Case B: two concurrent administrations of DIFFERENT scheduled doses -> both succeed independently.
  {
    const [doseA, doseB] = [dueRows[1], dueRows[2]];
    const results = await Promise.allSettled([
      administerMedication({ administrationId: doseA.id, status: "GIVEN", administeredByStaffId: nurse.id, safetyChecksConfirmed: true, byUserId: nurse.userId }),
      administerMedication({ administrationId: doseB.id, status: "GIVEN", administeredByStaffId: nurse.id, safetyChecksConfirmed: true, byUserId: nurse.userId }),
    ]);
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    report("CASE B: two concurrent administrations of two DIFFERENT scheduled doses — both succeed", succeeded === 2, `succeeded=${succeeded}`);
  }

  // Case C: same request retried after the first attempt already won (not concurrently) -> cleanly rejected, no second record.
  {
    const target = dueRows[3];
    await administerMedication({ administrationId: target.id, status: "GIVEN", administeredByStaffId: nurse.id, safetyChecksConfirmed: true, byUserId: nurse.userId });
    const retry = await administerMedication({ administrationId: target.id, status: "GIVEN", administeredByStaffId: nurse.id, safetyChecksConfirmed: true, byUserId: nurse.userId })
      .then(() => ({ ok: true as const }))
      .catch((err) => ({ ok: false as const, err }));
    report("CASE C: retrying an already-administered dose is rejected, not silently re-recorded", !retry.ok && retry.err instanceof AdministrationNotDueError);
  }

  // Case F: illegal medication order state — administering a dose whose order is not ACTIVE/DISPENSED is rejected.
  {
    const otherDrug = `P0CIllegalStateDrug${runId}`;
    const otherItem = await prisma.item.create({ data: { facilityId: facility.id, sku: `P0C-ILLEGAL-${runId}`, name: otherDrug, category: "MEDICATION", baseUnit: "TABLET" } });
    await prisma.$transaction((tx) => linkMedicationToItem(tx, { facilityId: facility.id, drugName: otherDrug, itemId: otherItem.id }));
    const otherOrder = await createMedicationOrder({
      facilityId: facility.id,
      encounterId: encounter.id,
      patientId: encounter.patientId,
      orderingStaffId: doctor.id,
      drugName: otherDrug,
      dose: "1 tablet",
      route: "PO",
      frequency: "OD",
      byUserId: doctor.userId,
    });
    if (otherOrder.blocked) throw new Error("Unexpected safety block in fixture.");
    // Left in PHARMACY_REVIEW deliberately — never verified/dispensed.
    const dueRow = await prisma.medicationAdministration.findFirstOrThrow({ where: { medicationOrderId: otherOrder.order.id, status: "DUE" } });
    const attempt = await administerMedication({ administrationId: dueRow.id, status: "GIVEN", administeredByStaffId: nurse.id, safetyChecksConfirmed: true, byUserId: nurse.userId })
      .then(() => ({ ok: true as const }))
      .catch((err) => ({ ok: false as const, err }));
    report("CASE F: administering a dose whose order is not ACTIVE/DISPENSED is rejected", !attempt.ok && attempt.err instanceof MedicationOrderNotActiveError);
  }

  // Case G: exactly one audit event for the successful administration (Case A's winning row).
  // Filtered in JS rather than via a JSON-path where-clause, since Prisma's
  // JSON filter type shape differs between the SQLite dev client (string)
  // and the Postgres client this script actually targets (string[]).
  {
    const target = dueRows[0];
    const candidates = await prisma.auditEvent.findMany({ where: { type: "hospital.medication.administered" } });
    const events = candidates.filter((e) => (e.detail as { administrationId?: string } | null)?.administrationId === target.id).length;
    report("CASE G: exactly one audit event recorded for the successful administration (no duplicate from the losing race attempt)", events === 1, `auditEvents=${events}`);
  }

  // Case H: administerMedication has no downstream stock/billing hooks (only dispenseMedication does) — the race must not have created any extra DispensingRecord/Charge/StockLedgerEntry.
  {
    const dispensingRecords = await prisma.dispensingRecord.findMany({ where: { medicationOrderId: created.order.id } });
    const dispensingRecordCount = dispensingRecords.length;
    const chargeCount = await prisma.charge.count({ where: { sourceType: "DispensingRecord", sourceId: { in: dispensingRecords.map((d) => d.id) } } });
    const ledgerCount = await prisma.stockLedgerEntry.count({ where: { sourceType: "DispensingRecord", sourceId: { in: dispensingRecords.map((d) => d.id) } } });
    report(
      "CASE H: exactly one DispensingRecord/Charge/StockLedgerEntry exist (administer races triggered no extra dispense/stock/billing side effects)",
      dispensingRecordCount === 1 && chargeCount === 1 && ledgerCount === 1,
      `dispensingRecords=${dispensingRecordCount}, charges=${chargeCount}, ledgerEntries=${ledgerCount}`
    );
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
