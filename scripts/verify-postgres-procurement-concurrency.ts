/**
 * Phase 6A manual verification: proves the procurement-lifecycle
 * concurrency invariants (races 3, 7, 8 of the required 8) hold against a
 * real PostgreSQL instance under genuine concurrent races. Mirrors
 * scripts/verify-postgres-billing-concurrency.ts's exact structure.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-procurement-concurrency.ts
 */
import { PrismaClient } from "@prisma/client";
import { createRequisitionDraft, addRequisitionLine, submitRequisition, approveRequisition, RequisitionConcurrencyError, SameActorApprovalError as ReqSameActorError } from "../src/lib/hospital/procurement/requisitions";
import { createPurchaseOrderDraft, addPurchaseOrderLine, submitForApproval, approvePurchaseOrder, PurchaseOrderConcurrencyError } from "../src/lib/hospital/procurement/purchaseOrders";
import { recordGoodsReceipt, approveGoodsReceipt, OverReceiptError } from "../src/lib/hospital/procurement/goodsReceipts";
import { createStockLocation } from "../src/lib/hospital/inventory/locations";

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
  const department = await prisma.department.findFirstOrThrow({ where: { facilityId: facility.id } });
  const admin1 = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { facilityId: facility.id, user: { role: "HOSPITAL_ADMIN" } } });
  const admin2 = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { facilityId: facility.id, user: { role: "PHARMACIST" } } });
  const item = await prisma.item.findFirstOrThrow({ where: { facilityId: facility.id, category: "MEDICATION" } });
  const supplier = await prisma.supplier.findFirstOrThrow({ where: { facilityId: facility.id } });
  const location = await prisma.$transaction((tx) => createStockLocation(tx, { facilityId: facility.id, name: `Verify-Procurement-Store-${runId}`, type: "WAREHOUSE" }));

  // 8. Genuine parallel race: two workers attempt to approve the same requisition — exactly one succeeds.
  {
    const requisition = await prisma.$transaction(async (tx) => {
      const draft = await createRequisitionDraft(tx, { facilityId: facility.id, departmentId: department.id, requestedByStaffId: admin1.id, justification: "verify-script race 8" });
      await addRequisitionLine(tx, draft.id, { itemId: item.id, quantity: 10, unit: "TABLET" });
      return submitRequisition(tx, draft.id);
    });

    const attempt = () =>
      prisma
        .$transaction((tx) => approveRequisition(tx, requisition.id, { approvedByStaffId: admin2.id }))
        .then(() => ({ ok: true as const }))
        .catch((err) => ({ ok: false as const, err }));

    const [r1, r2] = await Promise.all([attempt(), attempt()]);
    const successes = [r1, r2].filter((r) => r.ok).length;
    const conflicts = [r1, r2].filter((r) => !r.ok && r.err instanceof RequisitionConcurrencyError).length;
    report("Race 8 — requisition approval race: exactly one of two concurrent approvals succeeds", successes === 1 && conflicts === 1, `successes=${successes} conflicts=${conflicts}`);

    // Adversarial: same-actor self-approval must be rejected regardless of concurrency.
    const selfApprove = await prisma
      .$transaction(async (tx) => {
        const draft = await createRequisitionDraft(tx, { facilityId: facility.id, departmentId: department.id, requestedByStaffId: admin1.id, justification: "verify-script self-approve" });
        await addRequisitionLine(tx, draft.id, { itemId: item.id, quantity: 5, unit: "TABLET" });
        const submitted = await submitRequisition(tx, draft.id);
        return approveRequisition(tx, submitted.id, { approvedByStaffId: admin1.id });
      })
      .then(() => ({ ok: true as const }))
      .catch((err) => ({ ok: false as const, err }));
    report("Adversarial — same staff member cannot self-approve their own requisition", !selfApprove.ok && selfApprove.err instanceof ReqSameActorError);
  }

  // 7. Genuine parallel race: two workers attempt to approve the same purchase order — exactly one succeeds.
  {
    const po = await prisma.$transaction(async (tx) => {
      const draft = await createPurchaseOrderDraft(tx, { facilityId: facility.id, supplierId: supplier.id, createdByStaffId: admin1.id });
      await addPurchaseOrderLine(tx, draft.id, { itemId: item.id, orderedQuantity: 100, unit: "TABLET", unitPriceMinor: 150 });
      return submitForApproval(tx, draft.id);
    });

    const attempt = () =>
      prisma
        .$transaction((tx) => approvePurchaseOrder(tx, po.id, { approvedByStaffId: admin2.id }))
        .then(() => ({ ok: true as const }))
        .catch((err) => ({ ok: false as const, err }));

    const [r1, r2] = await Promise.all([attempt(), attempt()]);
    const successes = [r1, r2].filter((r) => r.ok).length;
    const conflicts = [r1, r2].filter((r) => !r.ok && r.err instanceof PurchaseOrderConcurrencyError).length;
    report("Race 7 — PO approval race: exactly one of two concurrent approvals succeeds", successes === 1 && conflicts === 1, `successes=${successes} conflicts=${conflicts}`);
  }

  // 3a. Genuine parallel race: two identical goods-receipt submissions with the SAME idempotencyKey — exactly one row created.
  {
    const po = await prisma.$transaction(async (tx) => {
      const draft = await createPurchaseOrderDraft(tx, { facilityId: facility.id, supplierId: supplier.id, createdByStaffId: admin1.id });
      await addPurchaseOrderLine(tx, draft.id, { itemId: item.id, orderedQuantity: 50, unit: "TABLET", unitPriceMinor: 150 });
      const submitted = await submitForApproval(tx, draft.id);
      return approvePurchaseOrder(tx, submitted.id, { approvedByStaffId: admin2.id });
    });
    const poLine = await prisma.purchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: po.id } });
    const idempotencyKey = `race3a-${runId}`;

    const attempt = () =>
      prisma
        .$transaction((tx) =>
          recordGoodsReceipt(tx, {
            facilityId: facility.id,
            purchaseOrderId: po.id,
            recordedByStaffId: admin1.id,
            lines: [{ purchaseOrderLineId: poLine.id, itemId: item.id, lotNumber: `RACE3A-${runId}`, acceptedQuantity: 50, locationId: location.id, unit: "TABLET" }],
            idempotencyKey,
          })
        )
        .then((r) => ({ ok: true as const, r }));

    const [r1, r2] = await Promise.all([attempt(), attempt()]);
    const wonCount = [r1, r2].filter((r) => !r.r.alreadyExisted).length;
    const sameReceiptId = r1.r.receipt.id === r2.r.receipt.id;
    report("Race 3a — duplicate goods-receipt submission (same idempotency key): exactly one row created, both calls return it", wonCount === 1 && sameReceiptId, `wonCount=${wonCount} sameReceiptId=${sameReceiptId}`);
    const lineCount = await prisma.goodsReceiptLine.count({ where: { goodsReceiptId: r1.r.receipt.id } });
    report("Race 3a — exactly one set of receipt lines exists, not duplicated", lineCount === 1, `lineCount=${lineCount}`);
  }

  // 3b. Over-receipt rejection: two DIFFERENT, both-legitimately-recorded receipts approved concurrently against the same PO line, combined exceeding orderedQuantity — the second approval is atomically rejected.
  {
    const po = await prisma.$transaction(async (tx) => {
      const draft = await createPurchaseOrderDraft(tx, { facilityId: facility.id, supplierId: supplier.id, createdByStaffId: admin1.id });
      await addPurchaseOrderLine(tx, draft.id, { itemId: item.id, orderedQuantity: 30, unit: "TABLET", unitPriceMinor: 150 });
      const submitted = await submitForApproval(tx, draft.id);
      return approvePurchaseOrder(tx, submitted.id, { approvedByStaffId: admin2.id });
    });
    const poLine = await prisma.purchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: po.id } });

    // Two separate receipts, each claiming the full 30 ordered — combined 60 > 30 ordered.
    const receiptA = await prisma.$transaction((tx) =>
      recordGoodsReceipt(tx, { facilityId: facility.id, purchaseOrderId: po.id, recordedByStaffId: admin1.id, lines: [{ purchaseOrderLineId: poLine.id, itemId: item.id, lotNumber: `RACE3B-A-${runId}`, acceptedQuantity: 30, locationId: location.id, unit: "TABLET" }], idempotencyKey: `race3b-a-${runId}` })
    );
    const receiptB = await prisma.$transaction((tx) =>
      recordGoodsReceipt(tx, { facilityId: facility.id, purchaseOrderId: po.id, recordedByStaffId: admin1.id, lines: [{ purchaseOrderLineId: poLine.id, itemId: item.id, lotNumber: `RACE3B-B-${runId}`, acceptedQuantity: 30, locationId: location.id, unit: "TABLET" }], idempotencyKey: `race3b-b-${runId}` })
    );

    const attempt = (receiptId: string) =>
      prisma
        .$transaction((tx) => approveGoodsReceipt(tx, receiptId, { approvedByStaffId: admin2.id, actorUserId: admin2.userId }))
        .then(() => ({ ok: true as const }))
        .catch((err) => ({ ok: false as const, err }));

    const [r1, r2] = await Promise.all([attempt(receiptA.receipt.id), attempt(receiptB.receipt.id)]);
    const successes = [r1, r2].filter((r) => r.ok).length;
    const overReceiptRejections = [r1, r2].filter((r) => !r.ok && r.err instanceof OverReceiptError).length;
    report("Race 3b — over-receipt rejected: exactly one of two concurrently-approved receipts (combined > ordered) succeeds", successes === 1 && overReceiptRejections === 1, `successes=${successes} rejections=${overReceiptRejections}`);
    const finalLine = await prisma.purchaseOrderLine.findUniqueOrThrow({ where: { id: poLine.id } });
    report("Race 3b — receivedQuantity never exceeds orderedQuantity", finalLine.receivedQuantity <= finalLine.orderedQuantity, `received=${finalLine.receivedQuantity} ordered=${finalLine.orderedQuantity}`);
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
