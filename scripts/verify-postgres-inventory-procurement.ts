/**
 * Phase B8 manual verification: Enterprise Inventory + Procurement Depth against
 * real PostgreSQL. Exercises the mandated race matrix (brief §48) with GENUINE
 * parallel calls (Promise.all): the existing Phase-6A guarded inventory/
 * procurement services (issue, reserve, transfer, waste, PO approval, partial
 * goods receipt, requisition approval) AND the B8-new flows (generic department
 * request, quotation selection, supplier-invoice duplicate reference, effective
 * contract price, serial transition), plus cross-facility isolation. Single-
 * winner / conservation invariants are asserted explicitly.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-inventory-procurement.ts
 */
import { PrismaClient, type Prisma } from "@prisma/client";
import { createAdjustment } from "../src/lib/hospital/inventory/adjustment";
import { issueStock } from "../src/lib/hospital/inventory/issue";
import { reserveStock } from "../src/lib/hospital/inventory/reservation";
import { initiateTransfer } from "../src/lib/hospital/inventory/transfer";
import { recordWaste } from "../src/lib/hospital/inventory/waste";
import { createRequisitionDraft, addRequisitionLine, submitRequisition, approveRequisition } from "../src/lib/hospital/procurement/requisitions";
import { createPurchaseOrderDraft, addPurchaseOrderLine, submitForApproval, approvePurchaseOrder } from "../src/lib/hospital/procurement/purchaseOrders";
import { recordGoodsReceipt, approveGoodsReceipt } from "../src/lib/hospital/procurement/goodsReceipts";
import { createDepartmentRequest, transitionDepartmentRequest, registerSerial, transitionSerial } from "../src/lib/hospital/inventory/inventoryAdvanced";
import { createRfq, recordQuotation, selectQuotation, recordSupplierInvoice, createSupplierContract, getEffectivePrice, transitionRfq } from "../src/lib/hospital/procurement/procurementAdvanced";

const prisma = new PrismaClient();
const runId = Date.now();
let pass = 0, fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  ok ? pass++ : fail++;
}
const tx = <T>(fn: (t: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction((t) => fn(t));

async function main() {
  const facility = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Medical Centre" } });
  const staffList = await prisma.hospitalStaffProfile.findMany({ where: { facilityId: facility.id }, take: 2 });
  const staff = staffList[0];
  const staff2 = staffList[1] ?? staffList[0];
  const location = await prisma.stockLocation.findFirstOrThrow({ where: { facilityId: facility.id } });
  const location2 = await prisma.stockLocation.create({ data: { facilityId: facility.id, name: `B8-LOC-${runId}`, type: "WARD_STORE" } });
  const department = await prisma.department.findFirst({ where: { facilityId: facility.id } }) ?? await prisma.department.create({ data: { facilityId: facility.id, name: `B8-DEPT-${runId}` } });

  let seq = 0;
  async function item() { seq++; return prisma.item.create({ data: { facilityId: facility.id, sku: `B8-${runId}-${seq}`, name: `Item ${seq}`, category: "CONSUMABLE", baseUnit: "PIECE" } }); }
  async function lotWithStock(itemId: string, qty: number, loc = location.id) {
    const lot = await prisma.itemLot.create({ data: { itemId, facilityId: facility.id, lotNumber: `L-${runId}-${++seq}`, status: "ACTIVE", expiresAt: new Date("2031-01-01") } });
    await tx((t) => createAdjustment(t, { facilityId: facility.id, itemId, lotId: lot.id, locationId: loc, quantityDelta: qty, reason: "FOUND", requestedByStaffId: staff.id, actorUserId: staff.userId, idempotencyKey: `seed-${lot.id}` }));
    return lot;
  }
  async function supplier() { seq++; return prisma.supplier.create({ data: { facilityId: facility.id, name: `Sup ${seq}`, code: `SUP-${runId}-${seq}` } }); }

  // ── 1: concurrent issue of the same 1-unit lot → one winner, no negative ──
  {
    const it = await item(); const lot = await lotWithStock(it.id, 1);
    const attempt = (i: number) => tx((t) => issueStock(t, { facilityId: facility.id, itemId: it.id, locationId: location.id, quantity: 1, lotId: lot.id, requestedByStaffId: staff.id, actorUserId: staff.userId, sourceType: "Test", sourceId: `iss-${runId}-${i}` })).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    const [r1, r2] = await Promise.all([attempt(1), attempt(2)]);
    const w = [r1, r2].filter((r) => r.ok).length;
    const bal = await prisma.stockBalance.findFirst({ where: { lotId: lot.id, locationId: location.id } });
    report("Concurrent issue of a 1-unit lot: exactly one wins, on-hand never negative", w === 1 && (bal?.onHandQty ?? -1) >= 0, `winners=${w}, onHand=${bal?.onHandQty}`);
  }

  // ── 2: concurrent reservation of the same stock (idempotency + threshold) ──
  {
    const it = await item(); const lot = await lotWithStock(it.id, 5);
    const attempt = () => tx((t) => reserveStock(t, { facilityId: facility.id, itemId: it.id, locationId: location.id, quantity: 5, lotId: lot.id, requestedByStaffId: staff.id, actorUserId: staff.userId, idempotencyKey: `resv-${lot.id}` })).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    await Promise.all([attempt(), attempt()]);
    const bal = await prisma.stockBalance.findFirst({ where: { lotId: lot.id, locationId: location.id } });
    report("Concurrent reservation (same idempotency key): reserved never exceeds on-hand", (bal?.reservedQty ?? 0) <= (bal?.onHandQty ?? 0) && (bal?.reservedQty ?? 0) === 5, `reserved=${bal?.reservedQty}, onHand=${bal?.onHandQty}`);
  }

  // ── 3: concurrent transfer of the same stock → one winner, no source overdraw ──
  {
    const it = await item(); const lot = await lotWithStock(it.id, 1);
    const attempt = (i: number) => tx((t) => initiateTransfer(t, { facilityId: facility.id, itemId: it.id, lotId: lot.id, fromLocationId: location.id, toLocationId: location2.id, quantity: 1, requestedByStaffId: staff.id, actorUserId: staff.userId, idempotencyKey: `xfer-${lot.id}-${i}` })).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    const [r1, r2] = await Promise.all([attempt(1), attempt(2)]);
    const w = [r1, r2].filter((r) => r.ok).length;
    const bal = await prisma.stockBalance.findFirst({ where: { lotId: lot.id, locationId: location.id } });
    report("Concurrent transfer of a 1-unit lot: exactly one wins, source never negative", w === 1 && (bal?.onHandQty ?? -1) >= 0, `winners=${w}, source=${bal?.onHandQty}`);
  }

  // ── 4: concurrent waste (same idempotency key) → single effect ──
  {
    const it = await item(); const lot = await lotWithStock(it.id, 2);
    const attempt = () => tx((t) => recordWaste(t, { facilityId: facility.id, itemId: it.id, lotId: lot.id, locationId: location.id, quantity: 2, reason: "DAMAGED", requestedByStaffId: staff.id, actorUserId: staff.userId, idempotencyKey: `waste-${lot.id}` })).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    await Promise.all([attempt(), attempt()]);
    const bal = await prisma.stockBalance.findFirst({ where: { lotId: lot.id, locationId: location.id } });
    const wastes = await prisma.wasteRecord.count({ where: { lotId: lot.id } });
    report("Concurrent waste (same key): single waste record, on-hand never negative", wastes === 1 && (bal?.onHandQty ?? -1) >= 0, `wastes=${wastes}, onHand=${bal?.onHandQty}`);
  }

  // ── 5: concurrent department-request transition (B8) → one winner ──
  {
    const it = await item(); await lotWithStock(it.id, 10);
    const req = await createDepartmentRequest({ facilityId: facility.id, itemId: it.id, quantity: 1, requestedByStaffId: staff.id, byUserId: staff.userId });
    const attempt = () => transitionDepartmentRequest({ requestId: req.id, facilityId: facility.id, to: "APPROVED", actorStaffId: staff2.id, byUserId: staff2.userId }).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    const [r1, r2] = await Promise.all([attempt(), attempt()]);
    const w = [r1, r2].filter((r) => r.ok).length;
    report("Concurrent department-request approval: exactly one winner", w === 1, `winners=${w}`);
  }

  // ── 6: concurrent quotation selection (B8) → one SELECTED per RFQ ──
  {
    const it = await item();
    const rfq = await createRfq({ facilityId: facility.id, lines: [{ itemId: it.id, quantity: 10, unit: "PIECE" }], createdByStaffId: staff.id, byUserId: staff.userId });
    await transitionRfq({ rfqId: rfq.id, facilityId: facility.id, to: "SENT", byUserId: staff.userId });
    const s1 = await supplier(); const s2 = await supplier();
    const q1 = await recordQuotation({ rfqId: rfq.id, facilityId: facility.id, supplierId: s1.id, lines: [{ itemId: it.id, unitPriceMinor: 1000, quantity: 10 }], recordedByStaffId: staff.id, byUserId: staff.userId });
    const q2 = await recordQuotation({ rfqId: rfq.id, facilityId: facility.id, supplierId: s2.id, lines: [{ itemId: it.id, unitPriceMinor: 900, quantity: 10 }], recordedByStaffId: staff.id, byUserId: staff.userId });
    const attempt = (qid: string) => selectQuotation({ quotationId: qid, facilityId: facility.id, byUserId: staff.userId }).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    const [r1, r2] = await Promise.all([attempt(q1.id), attempt(q2.id)]);
    const w = [r1, r2].filter((r) => r.ok).length;
    const selectedCount = await prisma.rfqQuotation.count({ where: { rfqId: rfq.id, selected: true } });
    report("Concurrent quotation selection: exactly one winner, one SELECTED quotation per RFQ", w === 1 && selectedCount === 1, `winners=${w}, selected=${selectedCount}`);
  }

  // ── 7: duplicate supplier-invoice reference (B8) → one rejected ──
  {
    const s = await supplier();
    const attempt = () => recordSupplierInvoice({ facilityId: facility.id, supplierId: s.id, invoiceRef: `INV-${runId}`, totalMinor: 5000, recordedByStaffId: staff.id, byUserId: staff.userId }).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    const [r1, r2] = await Promise.all([attempt(), attempt()]);
    const w = [r1, r2].filter((r) => r.ok).length;
    const count = await prisma.supplierInvoice.count({ where: { facilityId: facility.id, supplierId: s.id, invoiceRef: `INV-${runId}` } });
    report("Concurrent duplicate supplier-invoice reference: exactly one persists (unique constraint)", w === 1 && count === 1, `winners=${w}, rows=${count}`);
  }

  // ── 8: effective contract price (B8) returns the latest active contract ──
  {
    const it = await item(); const s = await supplier();
    await createSupplierContract({ facilityId: facility.id, supplierId: s.id, itemId: it.id, agreedPriceMinor: 1200, effectiveFrom: new Date(Date.now() - 86400_000), createdByStaffId: staff.id, byUserId: staff.userId });
    await createSupplierContract({ facilityId: facility.id, supplierId: s.id, itemId: it.id, agreedPriceMinor: 1100, effectiveFrom: new Date(), createdByStaffId: staff.id, byUserId: staff.userId });
    const eff = await getEffectivePrice(facility.id, s.id, it.id);
    report("Effective contract price returns the latest active contract (history not rewritten)", eff?.agreedPriceMinor === 1100, `effective=${eff?.agreedPriceMinor}`);
  }

  // ── 9: concurrent serial transition (B8) → one winner ──
  {
    const it = await item();
    const serial = await registerSerial({ facilityId: facility.id, itemId: it.id, serialNumber: `SER-${runId}`, byUserId: staff.userId });
    const attempt = () => transitionSerial({ serialId: serial.id, facilityId: facility.id, to: "ISSUED", byUserId: staff.userId }).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    const [r1, r2] = await Promise.all([attempt(), attempt()]);
    const w = [r1, r2].filter((r) => r.ok).length;
    report("Concurrent serial transition: exactly one winner", w === 1, `winners=${w}`);
  }

  // ── 10/11/12: PO pipeline + concurrent PO approval + partial goods receipt ──
  {
    const it = await item();
    const s = await supplier();
    const req = await tx((t) => createRequisitionDraft(t, { facilityId: facility.id, departmentId: department.id, requestedByStaffId: staff.id, justification: "test" }));
    await tx((t) => addRequisitionLine(t, req.id, { itemId: it.id, quantity: 100, unit: "PIECE" }));
    await tx((t) => submitRequisition(t, req.id));
    if (staff2.id !== staff.id) await tx((t) => approveRequisition(t, req.id, { approvedByStaffId: staff2.id }));

    const po = await tx((t) => createPurchaseOrderDraft(t, { facilityId: facility.id, supplierId: s.id, requisitionId: req.id, createdByStaffId: staff.id }));
    const poLine = await tx((t) => addPurchaseOrderLine(t, po.id, { itemId: it.id, orderedQuantity: 100, unit: "PIECE", unitPriceMinor: 1000 }));
    await tx((t) => submitForApproval(t, po.id));

    if (staff2.id !== staff.id) {
      const attempt = () => tx((t) => approvePurchaseOrder(t, po.id, { approvedByStaffId: staff2.id })).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
      const [a1, a2] = await Promise.all([attempt(), attempt()]);
      report("Concurrent PO approval: exactly one winner", [a1, a2].filter((r) => r.ok).length === 1, `winners=${[a1, a2].filter((r) => r.ok).length}`);
    } else {
      await tx((t) => approvePurchaseOrder(t, po.id, { approvedByStaffId: staff2.id })).catch(() => undefined);
      report("Concurrent PO approval (skipped — only one staff for same-actor guard)", true);
    }

    // Partial goods receipt: two concurrent receipts of 60 each against a 100 line → total accepted never exceeds 100.
    const gr = async (i: number) => {
      const { receipt } = await tx((t) => recordGoodsReceipt(t, { facilityId: facility.id, purchaseOrderId: po.id, recordedByStaffId: staff.id, idempotencyKey: `gr-${po.id}-${i}`, lines: [{ purchaseOrderLineId: poLine.id, itemId: it.id, lotNumber: `GRL-${runId}-${i}`, acceptedQuantity: 60, locationId: location.id, unit: "PIECE", unitCostMinor: 1000 }] }));
      return tx((t) => approveGoodsReceipt(t, receipt.id, { approvedByStaffId: staff2.id, actorUserId: staff2.userId })).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    };
    const [g1, g2] = staff2.id !== staff.id ? await Promise.all([gr(1), gr(2)]) : [await gr(1), { ok: false as const }];
    const finalLine = await prisma.purchaseOrderLine.findUniqueOrThrow({ where: { id: poLine.id } });
    report("Concurrent partial goods receipt (60+60 vs 100 ordered): received never exceeds ordered", finalLine.receivedQuantity <= 100 && [g1, g2].filter((r) => r.ok).length >= 1, `received=${finalLine.receivedQuantity}, accepts=${[g1, g2].filter((r) => r.ok).length}`);

    // Lot cost captured at receipt.
    const lot = await prisma.itemLot.findFirst({ where: { itemId: it.id, unitCostMinor: { not: null } } });
    report("Goods-receipt costing: received lot carries unitCostMinor", lot?.unitCostMinor === 1000, `unitCost=${lot?.unitCostMinor}`);
  }

  // ── 13/14: cross-facility isolation ──
  {
    const other = await prisma.facility.findFirst({ where: { id: { not: facility.id } } });
    const it = await item(); await lotWithStock(it.id, 5);
    const req = await createDepartmentRequest({ facilityId: facility.id, itemId: it.id, quantity: 1, requestedByStaffId: staff.id, byUserId: staff.userId });
    if (other) {
      const xf = await transitionDepartmentRequest({ requestId: req.id, facilityId: other.id, to: "APPROVED", actorStaffId: staff.id, byUserId: staff.userId }).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
      report("Cross-facility department-request mutation is denied", !xf.ok, `mutated=${xf.ok}`);
      const s = await supplier();
      const xi = await recordSupplierInvoice({ facilityId: other.id, supplierId: s.id, invoiceRef: `XF-${runId}`, totalMinor: 100, recordedByStaffId: staff.id, byUserId: staff.userId }).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
      report("Cross-facility supplier invoice (supplier from another facility) is denied", !xi.ok, `created=${xi.ok}`);
    } else {
      report("Cross-facility department-request mutation (skipped — one facility)", true);
      report("Cross-facility supplier invoice (skipped — one facility)", true);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });
