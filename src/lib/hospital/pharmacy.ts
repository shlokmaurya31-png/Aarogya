import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { isMedicationOrderTransitionAllowed } from "@/lib/hospital/medicationLifecycle";
import { issueStock } from "@/lib/hospital/inventory/issue";
import { reserveStock, releaseReservation } from "@/lib/hospital/inventory/reservation";
import { recordWaste } from "@/lib/hospital/inventory/waste";
import { initiateTransfer, receiveTransfer } from "@/lib/hospital/inventory/transfer";
import { quarantineLot, releaseLotFromQuarantine } from "@/lib/hospital/inventory/lots";
import { getOrCreateStockBalance, atomicIncrementOnHand } from "@/lib/hospital/inventory/stockBalance";
import { postLedgerEntry } from "@/lib/hospital/inventory/ledger";
import { resolveItemForDrugName } from "@/lib/hospital/inventory/itemMedicationLink";
import { createPricedChargeIfNotExists } from "@/lib/hospital/billing/chargeCapture";
import { PriceNotFoundError } from "@/lib/hospital/billing/pricing";
import type { Prisma, MedicationOrderStatus, MedicationReturnSource, MedicationReturnClassification, WasteReason, RequestPriority, PharmacyRequestStatus } from "@prisma/client";

/**
 * Enterprise Pharmacy service (Phase B6). An ORCHESTRATION layer over the
 * canonical medication + inventory core. MedicationOrder stays the clinical
 * order; Item/ItemLot/StockBalance/StockLedgerEntry/StockReservation/
 * StockTransfer/WasteRecord stay the physical stock system — EVERY physical
 * movement goes through the existing inventory services (issueStock/reserveStock/
 * recordWaste/initiateTransfer/quarantineLot), never a second ledger and never a
 * direct StockBalance mutation. MedicationAdministration stays the MAR. NO
 * dosing/interaction/substitution-recommendation/AI logic — this file records,
 * verifies, holds, dispenses, returns, quarantines, recalls, traces, reconciles.
 */

type Tx = Prisma.TransactionClient;

// ── Medication master ─────────────────────────────────────────────────────
export async function updateMedicationMaster(input: {
  itemId: string; facilityId: string;
  fields: Partial<{ genericName: string; brandName: string; strength: string; dosageForm: string; medicationRoute: string; concentration: string; therapeuticCategory: string; controlledClass: string; highAlert: boolean; storageRequirement: string; barcode: string; manufacturer: string; packSize: string; dispensingUnit: string }>;
  byUserId: string;
}) {
  const item = await prisma.item.findUnique({ where: { id: input.itemId } });
  if (!item || (item.facilityId && item.facilityId !== input.facilityId)) throw new NotFoundError("Item not found in this facility.");
  const updated = await prisma.item.update({ where: { id: input.itemId }, data: input.fields });
  await recordAuditEvent("hospital.pharmacy.masterUpdated", input.byUserId, { itemId: item.id }, { facilityId: input.facilityId });
  return updated;
}

// ── Formulary (facility-scoped, effective-dated) ────────────────────────────
export async function addFormularyEntry(input: { facilityId: string; itemId: string; restrictions?: string; requiresAuthorization?: boolean; notes?: string; effectiveFrom?: Date; createdByStaffId: string; byUserId: string }) {
  const item = await prisma.item.findUnique({ where: { id: input.itemId } });
  if (!item || (item.facilityId && item.facilityId !== input.facilityId)) throw new NotFoundError("Item not found in this facility.");
  const entry = await prisma.formularyEntry.create({
    data: { facilityId: input.facilityId, itemId: input.itemId, restrictions: input.restrictions, requiresAuthorization: input.requiresAuthorization ?? false, notes: input.notes, effectiveFrom: input.effectiveFrom ?? new Date(), createdByStaffId: input.createdByStaffId },
  });
  await recordAuditEvent("hospital.pharmacy.formularyChanged", input.byUserId, { formularyEntryId: entry.id, itemId: input.itemId, action: "ADDED" }, { facilityId: input.facilityId });
  return entry;
}

export async function deactivateFormularyEntry(input: { formularyEntryId: string; facilityId: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const entry = await tx.formularyEntry.findUnique({ where: { id: input.formularyEntryId } });
    if (!entry || entry.facilityId !== input.facilityId) throw new NotFoundError("Formulary entry not found.");
    const r = await tx.formularyEntry.updateMany({ where: { id: entry.id, active: true }, data: { active: false, effectiveTo: new Date() } });
    if (r.count !== 1) throw new BadRequestError("Formulary entry is already inactive.");
    await tx.auditEvent.create({ data: { type: "hospital.pharmacy.formularyChanged", userId: input.byUserId, detail: { formularyEntryId: entry.id, action: "DEACTIVATED" }, facilityId: input.facilityId } });
    return tx.formularyEntry.findUniqueOrThrow({ where: { id: entry.id } });
  });
}

/** Current formulary status for an item at a facility (documentary context, never an ordering gate). */
export async function getFormularyStatus(facilityId: string, itemId: string) {
  const now = new Date();
  const entry = await prisma.formularyEntry.findFirst({
    where: { facilityId, itemId, active: true, effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
    orderBy: { effectiveFrom: "desc" },
  });
  return { onFormulary: Boolean(entry), requiresAuthorization: entry?.requiresAuthorization ?? false, restrictions: entry?.restrictions ?? null, entry };
}

// ── Pharmacy stock view (over canonical inventory — no second ledger) ────────
export async function getPharmacyStock(facilityId: string, opts?: { locationId?: string; itemId?: string }) {
  const balances = await prisma.stockBalance.findMany({
    where: { facilityId, ...(opts?.locationId ? { locationId: opts.locationId } : {}), ...(opts?.itemId ? { itemId: opts.itemId } : {}) },
    include: { item: true, lot: true, location: true },
    orderBy: [{ lot: { expiresAt: "asc" } }],
    take: 500,
  });
  return balances.map((b) => ({
    itemId: b.itemId, itemName: b.item.name, sku: b.item.sku, highAlert: b.item.highAlert, controlledClass: b.item.controlledClass, storageRequirement: b.item.storageRequirement,
    lotId: b.lotId, lotNumber: b.lot.lotNumber, expiresAt: b.lot.expiresAt, lotStatus: b.lot.status, manufacturer: b.lot.manufacturer,
    locationId: b.locationId, locationName: b.location.name,
    onHand: b.onHandQty, reserved: b.reservedQty, available: b.onHandQty - b.reservedQty,
    quarantined: b.lot.status === "QUARANTINED", recalled: b.lot.status === "RECALLED", expired: b.lot.status === "EXPIRED" || (b.lot.expiresAt != null && b.lot.expiresAt.getTime() <= Date.now()),
  }));
}

// ── Dispensing (partial + multi-lot, transactional, concurrency-safe) ───────
export class OverDispenseError extends BadRequestError {
  constructor() { super("This dispense would exceed the ordered quantity. Refresh and try again."); }
}

/** Guarded order-status advance (VERIFIED -> DISPENSED -> ACTIVE), single-winner via status-preconditioned updateMany. */
async function advanceDispensedOrder(tx: Tx, orderId: string, current: MedicationOrderStatus, byUserId: string) {
  let status = current;
  for (const to of ["DISPENSED", "ACTIVE"] as MedicationOrderStatus[]) {
    if (status === to) continue;
    if (!isMedicationOrderTransitionAllowed(status, to)) break;
    const r = await tx.medicationOrder.updateMany({ where: { id: orderId, status }, data: { status: to } });
    if (r.count !== 1) break;
    await tx.auditEvent.create({ data: { type: "hospital.medication.statusChanged", userId: byUserId, detail: { orderId, from: status, to } } });
    status = to;
  }
}

/**
 * Dispense a medication order from the pharmacy — supports PARTIAL and MULTI-LOT
 * dispensing. Each lot allocation issues stock through the canonical, guarded,
 * over-issue-safe issueStock (FEFO-automatic when no lot is given; expired/
 * quarantined/recalled lots always rejected) and creates its own traceable
 * DispensingRecord sharing a dispenseGroupId. When the order carries a
 * dispenseTargetQuantity, a single atomic conditional UPDATE bounds cumulative
 * dispensing so `dispensed > ordered` is impossible under concurrency.
 */
export async function dispenseFromPharmacy(input: {
  medicationOrderId: string; facilityId: string; pharmacistStaffId: string; dispensingLocationId: string;
  allocations: { lotId?: string; quantity: number }[]; quantityUnit: string;
  witnessStaffId?: string; substitutedDrugName?: string; destination?: string; notes?: string; byUserId: string;
}) {
  if (input.allocations.length === 0) throw new BadRequestError("At least one lot allocation is required.");
  const totalQty = input.allocations.reduce((s, a) => s + a.quantity, 0);
  if (totalQty <= 0 || input.allocations.some((a) => a.quantity <= 0)) throw new BadRequestError("Allocation quantities must be positive.");

  const order = await prisma.medicationOrder.findUnique({ where: { id: input.medicationOrderId }, include: { encounter: true } });
  if (!order || order.encounter.facilityId !== input.facilityId) throw new NotFoundError("Medication order not found.");
  if (order.encounter.status === "CLOSED" || order.encounter.status === "CANCELLED") throw new BadRequestError("Cannot dispense against a closed encounter.");
  if (order.isControlled && !input.witnessStaffId) throw new BadRequestError("Controlled medication requires a witness co-sign to dispense.");

  const drugName = input.substitutedDrugName ?? order.drugName;
  const item = await resolveItemForDrugName(prisma, input.facilityId, drugName);
  if (!item) throw new BadRequestError(`No inventory item is mapped to "${drugName}".`);

  const dispenseGroupId = randomUUID();
  return prisma.$transaction(async (tx) => {
    // Guarded cumulative-dispense bound (only when a target is set). Atomic
    // conditional UPDATE — the read-check and the write are one statement.
    if (order.dispenseTargetQuantity != null) {
      const bounded = await tx.$executeRaw`
        UPDATE "MedicationOrder" SET "dispensedQuantity" = "dispensedQuantity" + ${totalQty}
        WHERE id = ${order.id} AND "dispensedQuantity" + ${totalQty} <= "dispenseTargetQuantity"
      `;
      if (Number(bounded) !== 1) throw new OverDispenseError();
    } else {
      await tx.$executeRaw`UPDATE "MedicationOrder" SET "dispensedQuantity" = "dispensedQuantity" + ${totalQty} WHERE id = ${order.id}`;
    }

    const records = [];
    for (const alloc of input.allocations) {
      const record = await tx.dispensingRecord.create({
        data: {
          medicationOrderId: order.id, pharmacistStaffId: input.pharmacistStaffId, status: "PARTIAL", quantity: alloc.quantity, quantityUnit: input.quantityUnit,
          substitutedDrugName: input.substitutedDrugName, destination: input.destination, witnessStaffId: input.witnessStaffId, notes: input.notes,
          dispenseGroupId, itemId: item.id, itemLotId: alloc.lotId,
        },
      });
      // Canonical, guarded, FEFO/expiry/quarantine/recall-safe stock issue.
      const issued = await issueStock(tx, {
        facilityId: input.facilityId, itemId: item.id, locationId: input.dispensingLocationId, quantity: alloc.quantity, lotId: alloc.lotId,
        requestedByStaffId: input.pharmacistStaffId, actorUserId: input.byUserId, reason: "Pharmacy dispense",
        patientId: order.patientId, encounterId: order.encounterId, sourceType: "DispensingRecord", sourceId: record.id,
      });
      // Record the actually-consumed lot (FEFO-resolved when not explicit).
      await tx.dispensingRecord.update({ where: { id: record.id }, data: { itemLotId: issued.lotId } });
      records.push({ ...record, itemLotId: issued.lotId });
    }

    const refreshed = await tx.medicationOrder.findUniqueOrThrow({ where: { id: order.id } });
    const fullyDispensed = refreshed.dispenseTargetQuantity == null || refreshed.dispensedQuantity >= refreshed.dispenseTargetQuantity;
    if (fullyDispensed) {
      for (const r of records) await tx.dispensingRecord.update({ where: { id: r.id }, data: { status: "FULL" } });
    }
    await advanceDispensedOrder(tx, order.id, order.status, input.byUserId);

    // Phase 5 charge hook — one charge per dispense group (not per lot), keyed
    // to the group so a partial/repeat dispense gets its own charge but a
    // multi-lot dispense is charged once. Falls back to a generic tariff.
    const chargeCode = `PHARMACY:${drugName.trim().toUpperCase()}`;
    const chargeBase = { encounterId: order.encounterId, patientId: order.patientId, facilityId: input.facilityId, category: "PHARMACY" as const, quantity: totalQty, sourceType: "PharmacyDispenseGroup", sourceId: dispenseGroupId, postedByUserId: input.byUserId };
    try {
      await createPricedChargeIfNotExists(tx, { ...chargeBase, description: `Pharmacy: ${drugName} x${totalQty}${input.quantityUnit}`, chargeCode });
    } catch (err) {
      if (err instanceof PriceNotFoundError) await createPricedChargeIfNotExists(tx, { ...chargeBase, description: `Pharmacy: ${drugName} x${totalQty}${input.quantityUnit} (generic tariff)`, chargeCode: "PHARMACY:GENERIC" });
      else throw err;
    }

    if (input.substitutedDrugName && input.substitutedDrugName !== order.drugName) {
      await tx.medicationSubstitution.create({ data: { facilityId: input.facilityId, medicationOrderId: order.id, originalDrugName: order.drugName, replacementItemId: item.id, replacementDrugName: input.substitutedDrugName, reason: input.notes ?? "Dispense-time substitution", authorizedByStaffId: input.pharmacistStaffId } });
    }
    await tx.auditEvent.create({ data: { type: "hospital.pharmacy.dispensed", userId: input.byUserId, detail: { orderId: order.id, dispenseGroupId, totalQty, lots: records.map((r) => r.itemLotId), controlled: order.isControlled, fullyDispensed }, facilityId: input.facilityId, patientId: order.patientId, encounterId: order.encounterId } });
    return { dispenseGroupId, records, order: refreshed, fullyDispensed };
  });
}

// ── Authorized substitution (explicit only — never recommended) ─────────────
export async function recordSubstitution(input: { medicationOrderId: string; facilityId: string; replacementDrugName: string; replacementItemId?: string; reason: string; authorizedByStaffId: string; byUserId: string }) {
  const order = await prisma.medicationOrder.findUnique({ where: { id: input.medicationOrderId }, include: { encounter: true } });
  if (!order || order.encounter.facilityId !== input.facilityId) throw new NotFoundError("Medication order not found.");
  const sub = await prisma.medicationSubstitution.create({
    data: { facilityId: input.facilityId, medicationOrderId: order.id, originalDrugName: order.drugName, replacementItemId: input.replacementItemId, replacementDrugName: input.replacementDrugName, reason: input.reason, authorizedByStaffId: input.authorizedByStaffId },
  });
  await recordAuditEvent("hospital.pharmacy.substitution", input.byUserId, { orderId: order.id, substitutionId: sub.id }, { facilityId: input.facilityId, patientId: order.patientId, encounterId: order.encounterId });
  return sub;
}

// ── Returns (never auto-available; explicit classification drives inventory) ─
export async function createMedicationReturn(input: {
  facilityId: string; itemId: string; locationId: string; quantity: number; unit?: string; source: MedicationReturnSource;
  medicationOrderId?: string; itemLotId?: string; patientId?: string; encounterId?: string; isControlled?: boolean; witnessStaffId?: string; returnedByStaffId: string; reason?: string; notes?: string; byUserId: string;
}) {
  if (input.quantity <= 0) throw new BadRequestError("Return quantity must be positive.");
  if (input.isControlled && !input.witnessStaffId) throw new BadRequestError("A controlled-medication return requires a witness.");
  return prisma.$transaction(async (tx) => {
    const item = await tx.item.findUnique({ where: { id: input.itemId } });
    if (!item || (item.facilityId && item.facilityId !== input.facilityId)) throw new NotFoundError("Item not found in this facility.");
    const loc = await tx.stockLocation.findUnique({ where: { id: input.locationId } });
    if (!loc || loc.facilityId !== input.facilityId) throw new NotFoundError("Location not found in this facility.");
    if (input.itemLotId) { const lot = await tx.itemLot.findUnique({ where: { id: input.itemLotId } }); if (!lot || lot.facilityId !== input.facilityId) throw new NotFoundError("Lot not found in this facility."); }
    const ret = await tx.medicationReturn.create({
      data: { facilityId: input.facilityId, itemId: input.itemId, itemLotId: input.itemLotId, locationId: input.locationId, quantity: input.quantity, unit: input.unit, source: input.source, medicationOrderId: input.medicationOrderId, patientId: input.patientId, encounterId: input.encounterId, isControlled: input.isControlled ?? false, witnessStaffId: input.witnessStaffId, returnedByStaffId: input.returnedByStaffId, reason: input.reason, notes: input.notes },
    });
    await tx.auditEvent.create({ data: { type: "hospital.pharmacy.returnCreated", userId: input.byUserId, detail: { returnId: ret.id, itemId: input.itemId, quantity: input.quantity, source: input.source, controlled: ret.isControlled }, facilityId: input.facilityId, patientId: input.patientId, encounterId: input.encounterId } });
    return ret;
  });
}

/** Classify a pending return — RETURN_TO_STOCK / QUARANTINE / WASTAGE — applying the canonical inventory movement. Guarded single-winner on PENDING_INSPECTION. */
export async function classifyMedicationReturn(input: { returnId: string; facilityId: string; classification: MedicationReturnClassification; inspectedByStaffId: string; wasteReason?: WasteReason; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const ret = await tx.medicationReturn.findUnique({ where: { id: input.returnId } });
    if (!ret || ret.facilityId !== input.facilityId) throw new NotFoundError("Return not found.");
    const claimed = await tx.medicationReturn.updateMany({ where: { id: ret.id, status: "PENDING_INSPECTION" }, data: { status: "COMPLETED", classification: input.classification, inspectedByStaffId: input.inspectedByStaffId } });
    if (claimed.count !== 1) throw new BadRequestError("Return has already been classified.");
    if (!ret.itemLotId && input.classification !== "RETURN_TO_STOCK") throw new BadRequestError("A lot is required to quarantine or waste a returned medication.");

    if (input.classification === "RETURN_TO_STOCK") {
      // Explicit eligibility determined by the inspector — never automatic.
      const lotId = ret.itemLotId;
      if (!lotId) throw new BadRequestError("A lot is required to return medication to stock.");
      const balance = await getOrCreateStockBalance(tx, { facilityId: ret.facilityId, itemId: ret.itemId, lotId, locationId: ret.locationId });
      await atomicIncrementOnHand(tx, balance.id, ret.quantity);
      const item = await tx.item.findUniqueOrThrow({ where: { id: ret.itemId } });
      await postLedgerEntry(tx, { facilityId: ret.facilityId, itemId: ret.itemId, lotId, locationId: ret.locationId, movementType: "RETURN", onHandDelta: ret.quantity, unit: item.baseUnit, reason: "Medication return to stock", patientId: ret.patientId, encounterId: ret.encounterId, sourceType: "MedicationReturn", sourceId: ret.id, actorUserId: input.byUserId, actorStaffId: input.inspectedByStaffId });
    } else if (input.classification === "QUARANTINE") {
      await quarantineLot(tx, ret.itemLotId!, { reason: `Return quarantine (${ret.source})`, byUserId: input.byUserId });
    } else {
      await recordWaste(tx, { facilityId: ret.facilityId, itemId: ret.itemId, lotId: ret.itemLotId!, locationId: ret.locationId, quantity: ret.quantity, reason: input.wasteReason ?? "OPENED_UNUSED", patientId: ret.patientId ?? undefined, encounterId: ret.encounterId ?? undefined, requestedByStaffId: input.inspectedByStaffId, actorUserId: input.byUserId, idempotencyKey: `return-waste-${ret.id}` });
    }
    await tx.auditEvent.create({ data: { type: "hospital.pharmacy.returnClassified", userId: input.byUserId, detail: { returnId: ret.id, classification: input.classification }, facilityId: ret.facilityId, patientId: ret.patientId, encounterId: ret.encounterId } });
    return tx.medicationReturn.findUniqueOrThrow({ where: { id: ret.id } });
  });
}

/** Direct controlled-medication wastage (brief §15) — witness-required, decrements stock via the canonical recordWaste, and leaves a traceable COMPLETED return-of-type-WASTAGE record. */
export async function recordControlledWastage(input: { facilityId: string; itemId: string; itemLotId: string; locationId: string; quantity: number; reason?: string; medicationOrderId?: string; patientId?: string; encounterId?: string; witnessStaffId: string; recordedByStaffId: string; wasteReason?: WasteReason; byUserId: string }) {
  if (input.quantity <= 0) throw new BadRequestError("Wastage quantity must be positive.");
  return prisma.$transaction(async (tx) => {
    const item = await tx.item.findUnique({ where: { id: input.itemId } });
    if (!item || (item.facilityId && item.facilityId !== input.facilityId)) throw new NotFoundError("Item not found in this facility.");
    const lot = await tx.itemLot.findUnique({ where: { id: input.itemLotId } });
    if (!lot || lot.facilityId !== input.facilityId) throw new NotFoundError("Lot not found in this facility.");
    const ret = await tx.medicationReturn.create({
      data: { facilityId: input.facilityId, itemId: input.itemId, itemLotId: input.itemLotId, locationId: input.locationId, quantity: input.quantity, source: "OTHER", classification: "WASTAGE", status: "COMPLETED", medicationOrderId: input.medicationOrderId, patientId: input.patientId, encounterId: input.encounterId, isControlled: true, witnessStaffId: input.witnessStaffId, returnedByStaffId: input.recordedByStaffId, inspectedByStaffId: input.recordedByStaffId, reason: input.reason },
    });
    await recordWaste(tx, { facilityId: input.facilityId, itemId: input.itemId, lotId: input.itemLotId, locationId: input.locationId, quantity: input.quantity, reason: input.wasteReason ?? "OPENED_UNUSED", patientId: input.patientId ?? undefined, encounterId: input.encounterId ?? undefined, requestedByStaffId: input.recordedByStaffId, actorUserId: input.byUserId, idempotencyKey: `ctrl-waste-${ret.id}` });
    await tx.auditEvent.create({ data: { type: "hospital.pharmacy.controlledWastage", userId: input.byUserId, detail: { returnId: ret.id, itemId: input.itemId, lotId: input.itemLotId, quantity: input.quantity, witnessStaffId: input.witnessStaffId }, facilityId: input.facilityId, patientId: input.patientId, encounterId: input.encounterId } });
    return ret;
  });
}

// ── Quarantine ──────────────────────────────────────────────────────────────
export async function quarantinePharmacyLot(input: { facilityId: string; itemLotId: string; reason: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const lot = await tx.itemLot.findUnique({ where: { id: input.itemLotId } });
    if (!lot || lot.facilityId !== input.facilityId) throw new NotFoundError("Lot not found in this facility.");
    const updated = await quarantineLot(tx, input.itemLotId, { reason: input.reason, byUserId: input.byUserId });
    await tx.auditEvent.create({ data: { type: "hospital.pharmacy.quarantined", userId: input.byUserId, detail: { itemLotId: input.itemLotId, reason: input.reason }, facilityId: input.facilityId } });
    return updated;
  });
}

export async function releasePharmacyQuarantine(input: { facilityId: string; itemLotId: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const lot = await tx.itemLot.findUnique({ where: { id: input.itemLotId } });
    if (!lot || lot.facilityId !== input.facilityId) throw new NotFoundError("Lot not found in this facility.");
    if (lot.status === "RECALLED") throw new BadRequestError("A recalled lot cannot be released from quarantine.");
    const updated = await releaseLotFromQuarantine(tx, input.itemLotId, { byUserId: input.byUserId });
    await tx.auditEvent.create({ data: { type: "hospital.pharmacy.quarantineReleased", userId: input.byUserId, detail: { itemLotId: input.itemLotId }, facilityId: input.facilityId } });
    return updated;
  });
}

// ── Recall (over canonical Item/ItemLot; sets LotStatus RECALLED) ────────────
export async function createRecall(input: { facilityId: string; itemId: string; itemLotId?: string; manufacturer?: string; batchRef?: string; reason: string; reference?: string; createdByStaffId: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const item = await tx.item.findUnique({ where: { id: input.itemId } });
    if (!item || (item.facilityId && item.facilityId !== input.facilityId)) throw new NotFoundError("Item not found in this facility.");
    // Determine affected lots: an explicit lot, else every non-terminal lot of the item in this facility.
    const lots = input.itemLotId
      ? await tx.itemLot.findMany({ where: { id: input.itemLotId, facilityId: input.facilityId } })
      : await tx.itemLot.findMany({ where: { itemId: input.itemId, facilityId: input.facilityId, status: { in: ["ACTIVE", "QUARANTINED"] } } });
    if (input.itemLotId && lots.length === 0) throw new NotFoundError("Lot not found in this facility.");
    const recall = await tx.medicationRecall.create({ data: { facilityId: input.facilityId, itemId: input.itemId, itemLotId: input.itemLotId, manufacturer: input.manufacturer, batchRef: input.batchRef, reason: input.reason, reference: input.reference, createdByStaffId: input.createdByStaffId } });
    for (const lot of lots) {
      // Guarded: only pull issuable/quarantined lots into RECALLED (terminal-safe).
      await tx.itemLot.updateMany({ where: { id: lot.id, status: { in: ["ACTIVE", "QUARANTINED"] } }, data: { status: "RECALLED", quarantineReason: `Recall: ${input.reason}`, quarantinedAt: new Date(), quarantinedByUserId: input.byUserId } });
    }
    await tx.auditEvent.create({ data: { type: "hospital.pharmacy.recallCreated", userId: input.byUserId, detail: { recallId: recall.id, itemId: input.itemId, itemLotId: input.itemLotId, affectedLots: lots.map((l) => l.id) }, facilityId: input.facilityId } });
    return recall;
  });
}

export async function closeRecall(input: { recallId: string; facilityId: string; closedByStaffId: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const recall = await tx.medicationRecall.findUnique({ where: { id: input.recallId } });
    if (!recall || recall.facilityId !== input.facilityId) throw new NotFoundError("Recall not found.");
    const r = await tx.medicationRecall.updateMany({ where: { id: recall.id, status: "OPEN" }, data: { status: "CLOSED", closedByStaffId: input.closedByStaffId, closedAt: new Date() } });
    if (r.count !== 1) throw new BadRequestError("Recall is already closed.");
    await tx.auditEvent.create({ data: { type: "hospital.pharmacy.recallClosed", userId: input.byUserId, detail: { recallId: recall.id }, facilityId: input.facilityId } });
    return tx.medicationRecall.findUniqueOrThrow({ where: { id: recall.id } });
  });
}

// ── Expiry visibility ────────────────────────────────────────────────────────
export async function getExpiryReport(facilityId: string, opts?: { windowDays?: number }) {
  const windowDays = opts?.windowDays ?? 30;
  const now = new Date();
  const horizon = new Date(now.getTime() + windowDays * 24 * 3600_000);
  const lots = await prisma.itemLot.findMany({
    where: { facilityId, expiresAt: { not: null, lte: horizon } },
    include: { item: true, stockBalances: { include: { location: true } } },
    orderBy: { expiresAt: "asc" }, take: 300,
  });
  return lots.map((l) => ({
    lotId: l.id, itemId: l.itemId, itemName: l.item.name, lotNumber: l.lotNumber, expiresAt: l.expiresAt, status: l.status,
    expired: l.status === "EXPIRED" || (l.expiresAt != null && l.expiresAt.getTime() <= now.getTime()),
    onHand: l.stockBalances.reduce((s, b) => s + b.onHandQty, 0),
    locations: l.stockBalances.filter((b) => b.onHandQty > 0).map((b) => ({ locationId: b.locationId, locationName: b.location.name, onHand: b.onHandQty })),
  }));
}

// ── Documentary storage check ────────────────────────────────────────────────
export async function recordStorageCheck(input: { facilityId: string; locationId: string; recordedValue: number; unit: string; status?: string; recordedByStaffId: string; notes?: string; byUserId: string }) {
  const loc = await prisma.stockLocation.findUnique({ where: { id: input.locationId } });
  if (!loc || loc.facilityId !== input.facilityId) throw new NotFoundError("Location not found in this facility.");
  const check = await prisma.pharmacyStorageCheck.create({ data: { facilityId: input.facilityId, locationId: input.locationId, recordedValue: input.recordedValue, unit: input.unit, status: input.status, recordedByStaffId: input.recordedByStaffId, notes: input.notes } });
  await recordAuditEvent("hospital.pharmacy.storageCheck", input.byUserId, { checkId: check.id, locationId: input.locationId, value: input.recordedValue }, { facilityId: input.facilityId });
  return check;
}

// ── Ward/ICU/ED/OT requests ──────────────────────────────────────────────────
export async function createPharmacyRequest(input: { facilityId: string; itemId: string; quantity: number; unit?: string; requestingLocationId?: string; patientId?: string; encounterId?: string; priority?: RequestPriority; requestedByStaffId: string; reason?: string; byUserId: string }) {
  if (input.quantity <= 0) throw new BadRequestError("Request quantity must be positive.");
  const item = await prisma.item.findUnique({ where: { id: input.itemId } });
  if (!item || (item.facilityId && item.facilityId !== input.facilityId)) throw new NotFoundError("Item not found in this facility.");
  const req = await prisma.pharmacyRequest.create({ data: { facilityId: input.facilityId, itemId: input.itemId, quantity: input.quantity, unit: input.unit, requestingLocationId: input.requestingLocationId, patientId: input.patientId, encounterId: input.encounterId, priority: input.priority ?? "ROUTINE", requestedByStaffId: input.requestedByStaffId, reason: input.reason } });
  await recordAuditEvent("hospital.pharmacy.requestCreated", input.byUserId, { requestId: req.id, itemId: input.itemId, quantity: input.quantity }, { facilityId: input.facilityId, patientId: input.patientId, encounterId: input.encounterId });
  return req;
}

const REQUEST_TRANSITIONS: Record<PharmacyRequestStatus, PharmacyRequestStatus[]> = {
  REQUESTED: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["RESERVED", "ISSUED", "CANCELLED"],
  RESERVED: ["ISSUED", "CANCELLED"],
  ISSUED: ["RECEIVED"],
  RECEIVED: [],
  CANCELLED: [],
  REJECTED: [],
};

/** Pure predicate for the ward-request lifecycle (exported for unit testing without a DB). */
export function isPharmacyRequestTransitionAllowed(from: PharmacyRequestStatus, to: PharmacyRequestStatus): boolean {
  return REQUEST_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Guarded ward-request lifecycle transition (single-winner). Reserve/issue attach the canonical reservation/transfer rows. */
export async function transitionPharmacyRequest(input: { requestId: string; facilityId: string; to: PharmacyRequestStatus; actorStaffId: string; fulfillLocationId?: string; lotId?: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const req = await tx.pharmacyRequest.findUnique({ where: { id: input.requestId } });
    if (!req || req.facilityId !== input.facilityId) throw new NotFoundError("Pharmacy request not found.");
    if (!(REQUEST_TRANSITIONS[req.status]?.includes(input.to) ?? false)) throw new BadRequestError(`Illegal request transition ${req.status} -> ${input.to}.`);
    const data: Prisma.PharmacyRequestUpdateManyMutationInput = { status: input.to, reviewedByStaffId: input.actorStaffId };
    if (input.fulfillLocationId) data.fulfillLocationId = input.fulfillLocationId;

    if (input.to === "RESERVED") {
      const loc = input.fulfillLocationId ?? req.fulfillLocationId;
      if (!loc) throw new BadRequestError("A fulfill location is required to reserve.");
      const { reservation } = await reserveStock(tx, { facilityId: req.facilityId, itemId: req.itemId, locationId: loc, quantity: req.quantity, lotId: input.lotId, reservedForType: "PharmacyRequest", reservedForId: req.id, patientId: req.patientId ?? undefined, encounterId: req.encounterId ?? undefined, requestedByStaffId: input.actorStaffId, actorUserId: input.byUserId, idempotencyKey: `phreq-resv-${req.id}` });
      data.reservationId = reservation.id;
    } else if (input.to === "ISSUED") {
      const loc = input.fulfillLocationId ?? req.fulfillLocationId;
      if (!loc || !req.requestingLocationId) throw new BadRequestError("Fulfill and requesting locations are required to issue.");
      // Release any active reservation, then transfer stock to the requesting location.
      if (req.reservationId) await releaseReservation(tx, req.reservationId, { byUserId: input.byUserId }).catch(() => undefined);
      const { transfer } = await initiateTransfer(tx, { facilityId: req.facilityId, itemId: req.itemId, lotId: input.lotId ?? (await tx.stockReservation.findUnique({ where: { id: req.reservationId ?? "" } }))?.lotId ?? await pickLotForRequest(tx, req.facilityId, req.itemId, loc, req.quantity), fromLocationId: loc, toLocationId: req.requestingLocationId, quantity: req.quantity, requestedByStaffId: input.actorStaffId, actorUserId: input.byUserId, reason: "Pharmacy request issue", idempotencyKey: `phreq-xfer-${req.id}` });
      data.transferId = transfer.id;
    } else if (input.to === "RECEIVED") {
      if (req.transferId) await receiveTransfer(tx, req.transferId, { receivedByStaffId: input.actorStaffId, actorUserId: input.byUserId }).catch(() => undefined);
    } else if (input.to === "CANCELLED" || input.to === "REJECTED") {
      if (req.reservationId) await releaseReservation(tx, req.reservationId, { byUserId: input.byUserId }).catch(() => undefined);
    }

    const r = await tx.pharmacyRequest.updateMany({ where: { id: req.id, status: req.status }, data });
    if (r.count !== 1) throw new BadRequestError("Request changed state concurrently — refresh and try again.");
    await tx.auditEvent.create({ data: { type: "hospital.pharmacy.requestUpdated", userId: input.byUserId, detail: { requestId: req.id, from: req.status, to: input.to }, facilityId: req.facilityId, patientId: req.patientId, encounterId: req.encounterId } });
    return tx.pharmacyRequest.findUniqueOrThrow({ where: { id: req.id } });
  });
}

async function pickLotForRequest(tx: Tx, facilityId: string, itemId: string, locationId: string, quantity: number) {
  const { selectFefoLot } = await import("@/lib/hospital/inventory/fefo");
  return (await selectFefoLot(tx, { itemId, locationId, quantity })).lotId;
}

// ── Pharmacy transfers (reuse StockTransfer) ─────────────────────────────────
export async function createPharmacyTransfer(input: { facilityId: string; itemId: string; lotId: string; fromLocationId: string; toLocationId: string; quantity: number; requestedByStaffId: string; reason?: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const { transfer } = await initiateTransfer(tx, { facilityId: input.facilityId, itemId: input.itemId, lotId: input.lotId, fromLocationId: input.fromLocationId, toLocationId: input.toLocationId, quantity: input.quantity, requestedByStaffId: input.requestedByStaffId, actorUserId: input.byUserId, reason: input.reason ?? "Pharmacy transfer", idempotencyKey: `phxfer-${randomUUID()}` });
    await tx.auditEvent.create({ data: { type: "hospital.pharmacy.transfer", userId: input.byUserId, detail: { transferId: transfer.id, itemId: input.itemId, lotId: input.lotId, fromLocationId: input.fromLocationId, toLocationId: input.toLocationId, quantity: input.quantity }, facilityId: input.facilityId } });
    return transfer;
  });
}

// ── Traceability ──────────────────────────────────────────────────────────────
/** "Where did this lot go / which patients received it?" — composed from the canonical ledger + dispensing records. */
export async function traceLot(lotId: string, facilityId: string) {
  const lot = await prisma.itemLot.findUnique({ where: { id: lotId }, include: { item: true } });
  if (!lot || lot.facilityId !== facilityId) throw new NotFoundError("Lot not found in this facility.");
  const [ledger, dispensings] = await Promise.all([
    prisma.stockLedgerEntry.findMany({ where: { lotId, facilityId }, include: { location: true }, orderBy: { postedAt: "desc" }, take: 300 }),
    prisma.dispensingRecord.findMany({ where: { itemLotId: lotId }, include: { medicationOrder: { include: { patient: true } } }, orderBy: { createdAt: "desc" }, take: 300 }),
  ]);
  const patients = new Map<string, { patientId: string; fullName: string; uhid: string; quantity: number }>();
  for (const d of dispensings) {
    const p = d.medicationOrder.patient;
    const cur = patients.get(p.id) ?? { patientId: p.id, fullName: p.fullName, uhid: p.uhid, quantity: 0 };
    cur.quantity += d.quantity;
    patients.set(p.id, cur);
  }
  return { lot: { id: lot.id, lotNumber: lot.lotNumber, itemName: lot.item.name, status: lot.status, expiresAt: lot.expiresAt }, movements: ledger, dispensings, patients: [...patients.values()] };
}

/** Full patient medication trace for recall/adverse-event investigation (no causal inference). */
export async function getPatientMedicationTrace(patientId: string, facilityId: string) {
  const patient = await prisma.patient.findUnique({ where: { id: patientId } });
  if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");
  const [orders, returns, reconciliations] = await Promise.all([
    prisma.medicationOrder.findMany({ where: { patientId, encounter: { facilityId } }, include: { verifications: true, dispensingRecords: true, administrations: true }, orderBy: { orderedAt: "desc" }, take: 200 }),
    prisma.medicationReturn.findMany({ where: { patientId, facilityId }, orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.medicationReconciliation.findMany({ where: { patientId }, orderBy: { createdAt: "desc" }, take: 100 }).catch(() => []),
  ]);
  return { patient: { id: patient.id, fullName: patient.fullName, uhid: patient.uhid }, orders, returns, reconciliations };
}

// ── Command center ────────────────────────────────────────────────────────────
export async function buildPharmacyCommandCenter(facilityId: string) {
  const now = new Date();
  const soon = new Date(now.getTime() + 30 * 24 * 3600_000);
  const [pendingVerification, held, rejected, readyToDispense, controlledPending, expiringLots, expiredLots, quarantinedLots, recalledLots, openRecalls, pendingReturns, requestsPending, lowStock] = await Promise.all([
    prisma.medicationOrder.count({ where: { encounter: { facilityId }, status: "PHARMACY_REVIEW" } }),
    prisma.medicationOrder.count({ where: { encounter: { facilityId }, status: "HELD" } }),
    prisma.medicationOrder.count({ where: { encounter: { facilityId }, status: "REJECTED" } }),
    prisma.medicationOrder.count({ where: { encounter: { facilityId }, status: "VERIFIED" } }),
    prisma.medicationOrder.count({ where: { encounter: { facilityId }, status: { in: ["PHARMACY_REVIEW", "VERIFIED"] }, isControlled: true } }),
    prisma.itemLot.count({ where: { facilityId, status: "ACTIVE", expiresAt: { not: null, gt: now, lte: soon } } }),
    prisma.itemLot.count({ where: { facilityId, OR: [{ status: "EXPIRED" }, { expiresAt: { not: null, lte: now } }] } }),
    prisma.itemLot.count({ where: { facilityId, status: "QUARANTINED" } }),
    prisma.itemLot.count({ where: { facilityId, status: "RECALLED" } }),
    prisma.medicationRecall.count({ where: { facilityId, status: "OPEN" } }),
    prisma.medicationReturn.count({ where: { facilityId, status: "PENDING_INSPECTION" } }),
    prisma.pharmacyRequest.count({ where: { facilityId, status: { in: ["REQUESTED", "APPROVED", "RESERVED", "ISSUED"] } } }),
    prisma.stockBalance.count({ where: { facilityId, item: { category: "MEDICATION", reorderPoint: { not: null } }, onHandQty: { lte: 0 } } }),
  ]);
  return {
    verification: { pendingVerification, held, rejected },
    dispensing: { readyToDispense, controlledPending },
    inventory: { expiringLots, expiredLots, quarantinedLots, recalledLots, lowStock },
    controlled: { pending: controlledPending },
    returns: { pendingReturns },
    requests: { pending: requestsPending },
    recalls: { open: openRecalls },
  };
}
