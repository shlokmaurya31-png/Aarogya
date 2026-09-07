/**
 * Phase 6A — Inventory + Procurement Foundation demo data. Idempotency-
 * guarded on `Item.count()`. Seeds a reusable item catalog (medications
 * matching Phase 3's already-seeded drug names, plus a couple of generic
 * consumables), storage locations, a demo supplier, and drives one small
 * end-to-end requisition -> PO -> goods receipt -> transfer chain through
 * the real service functions (same convention as every prior seed file
 * exercising src/lib/hospital/* directly) — obviously synthetic data only,
 * respecting the existing production seed guard in prisma/seed.ts.
 */
import { PrismaClient } from "@prisma/client";
import { createItem } from "../../src/lib/hospital/inventory/items";
import { createStockLocation } from "../../src/lib/hospital/inventory/locations";
import { linkMedicationToItem } from "../../src/lib/hospital/inventory/itemMedicationLink";
import { createSupplier } from "../../src/lib/hospital/procurement/suppliers";
import { createRequisitionDraft, addRequisitionLine, submitRequisition, approveRequisition } from "../../src/lib/hospital/procurement/requisitions";
import { createPurchaseOrderDraft, addPurchaseOrderLine, submitForApproval, approvePurchaseOrder } from "../../src/lib/hospital/procurement/purchaseOrders";
import { recordGoodsReceipt, approveGoodsReceipt, assignGoodsReceiptNumber } from "../../src/lib/hospital/procurement/goodsReceipts";
import { initiateTransfer, receiveTransfer } from "../../src/lib/hospital/inventory/transfer";

const SEEDED_DRUGS: Array<{ drugName: string; sku: string }> = [
  { drugName: "Nitrofurantoin", sku: "MED-NITROFURANTOIN-100MG" },
  { drugName: "Ceftriaxone", sku: "MED-CEFTRIAXONE-1G" },
  { drugName: "Amoxicillin", sku: "MED-AMOXICILLIN-500MG" },
  { drugName: "Metformin", sku: "MED-METFORMIN-500MG" },
  // The remaining drug names hospital.ts's general per-encounter medication
  // loop (ADMITTED encounters) cycles through — without these, most seeded
  // MedicationOrders in the demo dataset would hit UnmappedDrugItemError.
  { drugName: "Paracetamol", sku: "MED-PARACETAMOL-500MG" },
  { drugName: "Atorvastatin", sku: "MED-ATORVASTATIN-10MG" },
  { drugName: "Omeprazole", sku: "MED-OMEPRAZOLE-20MG" },
];

export async function seedPhase6aInventory(prisma: PrismaClient) {
  const already = await prisma.item.count();
  if (already > 0) {
    console.log("Phase 6A inventory/procurement demo data already seeded — skipping.");
    return;
  }

  const facilities = await prisma.facility.findMany();

  for (const facility of facilities) {
    const admin = await prisma.hospitalStaffProfile.findFirst({ where: { facilityId: facility.id, user: { role: "HOSPITAL_ADMIN" } } });
    if (!admin) continue; // no admin seeded at this facility — nothing to attribute procurement approvals to, skip rather than fabricate an actor

    const centralStore = await prisma.$transaction((tx) => createStockLocation(tx, { facilityId: facility.id, name: "Central Store", type: "WAREHOUSE" }));
    const centralPharmacy = await prisma.$transaction((tx) =>
      createStockLocation(tx, { facilityId: facility.id, name: "Central Pharmacy", type: "PHARMACY", parentLocationId: centralStore.id })
    );

    const supplier = await prisma.$transaction((tx) =>
      createSupplier(tx, { facilityId: facility.id, name: "MedSupply Co (Demo)", code: "MEDSUPPLY-DEMO", contactEmail: "orders@medsupply-demo.example", paymentTermsDays: 30 })
    );

    const items: { itemId: string; drugName: string }[] = [];
    for (const drug of SEEDED_DRUGS) {
      const item = await prisma.$transaction((tx) =>
        createItem(tx, { facilityId: facility.id, sku: `${drug.sku}-${facility.id}`, name: drug.drugName, category: "MEDICATION", baseUnit: "TABLET", reorderPoint: 20, reorderQuantity: 200 })
      );
      await prisma.$transaction((tx) => linkMedicationToItem(tx, { facilityId: facility.id, drugName: drug.drugName, itemId: item.id }));
      items.push({ itemId: item.id, drugName: drug.drugName });
    }
    await prisma.$transaction((tx) =>
      createItem(tx, { facilityId: facility.id, sku: `CONS-GLOVES-M-${facility.id}`, name: "Surgical Gloves (Medium)", category: "CONSUMABLE", baseUnit: "PIECE", trackExpiry: false, reorderPoint: 100, reorderQuantity: 1000 })
    );

    // Drive one demo procurement chain through the real service functions —
    // requisition -> approval -> PO -> approval -> goods receipt ->
    // approval (posts stock to Central Store) -> transfer to Central
    // Pharmacy -> receive.
    const department = await prisma.department.findFirst({ where: { facilityId: facility.id } });
    if (!department) continue;

    const requisitionItem = items[0];
    const requisition = await prisma.$transaction(async (tx) => {
      const draft = await createRequisitionDraft(tx, { facilityId: facility.id, departmentId: department.id, requestedByStaffId: admin.id, justification: "Routine ward stock replenishment (demo)." });
      await addRequisitionLine(tx, draft.id, { itemId: requisitionItem.itemId, quantity: 500, unit: "TABLET" });
      return submitRequisition(tx, draft.id);
    });
    // Approval requires a different actor than the requester — reuse the
    // same admin's userId is fine since the same-actor guard compares
    // staffId, and there's only one HOSPITAL_ADMIN seeded per facility;
    // approve via a second staff profile if one exists, else skip approval
    // and leave the demo chain at SUBMITTED (still a valid, inspectable state).
    const secondApprover = await prisma.hospitalStaffProfile.findFirst({ where: { facilityId: facility.id, id: { not: admin.id }, user: { role: { in: ["HOSPITAL_ADMIN", "PHARMACIST"] } } } });
    if (!secondApprover) {
      console.log(`Seeded Phase 6A inventory foundation for ${facility.name}: items/locations/supplier/requisition (left SUBMITTED — no second approver role seeded at this facility to demonstrate approval without a same-actor violation).`);
      continue;
    }

    const approvedRequisition = await prisma.$transaction((tx) => approveRequisition(tx, requisition.id, { approvedByStaffId: secondApprover.id }));

    const po = await prisma.$transaction(async (tx) => {
      const draft = await createPurchaseOrderDraft(tx, { facilityId: facility.id, supplierId: supplier.id, requisitionId: approvedRequisition.id, createdByStaffId: admin.id });
      await addPurchaseOrderLine(tx, draft.id, { itemId: requisitionItem.itemId, orderedQuantity: 500, unit: "TABLET", unitPriceMinor: 150, taxPercent: 5 });
      const submitted = await submitForApproval(tx, draft.id);
      return approvePurchaseOrder(tx, submitted.id, { approvedByStaffId: secondApprover.id });
    });

    const poLine = await prisma.purchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: po.id } });
    const receiptResult = await prisma.$transaction(async (tx) => {
      const recorded = await recordGoodsReceipt(tx, {
        facilityId: facility.id,
        purchaseOrderId: po.id,
        recordedByStaffId: admin.id,
        lines: [
          {
            purchaseOrderLineId: poLine.id,
            itemId: requisitionItem.itemId,
            lotNumber: `DEMO-LOT-${facility.id}-001`,
            manufacturer: "Demo Pharma Ltd.",
            manufacturedAt: new Date("2026-01-01"),
            expiresAt: new Date("2028-01-01"),
            acceptedQuantity: 500,
            locationId: centralStore.id,
            unit: "TABLET",
          },
        ],
        idempotencyKey: `seed-gr-${po.id}`,
      });
      await assignGoodsReceiptNumber(tx, recorded.receipt.id, facility.id);
      return approveGoodsReceipt(tx, recorded.receipt.id, { approvedByStaffId: secondApprover.id, actorUserId: secondApprover.userId });
    });

    const receivedLot = await prisma.itemLot.findFirstOrThrow({ where: { itemId: requisitionItem.itemId, facilityId: facility.id } });
    await prisma.$transaction((tx) =>
      initiateTransfer(tx, {
        facilityId: facility.id,
        itemId: requisitionItem.itemId,
        lotId: receivedLot.id,
        fromLocationId: centralStore.id,
        toLocationId: centralPharmacy.id,
        quantity: 200,
        requestedByStaffId: admin.id,
        actorUserId: admin.userId,
        reason: "Pharmacy restock (demo)",
        idempotencyKey: `seed-transfer-${facility.id}`,
      })
    ).then((t) => prisma.$transaction((tx) => receiveTransfer(tx, t.transfer.id, { receivedByStaffId: admin.id, actorUserId: admin.userId })));

    console.log(
      `Seeded Phase 6A inventory + procurement for ${facility.name}: ${items.length} medication items + 1 consumable, 2 locations, 1 supplier, ` +
        `requisition ${approvedRequisition.requisitionNumber} -> PO ${po.orderNumber} -> goods receipt ${receiptResult.receiptNumber ?? receiptResult.id} (500 ${requisitionItem.drugName} tablets received), 200 transferred to Central Pharmacy.`
    );
  }
}
