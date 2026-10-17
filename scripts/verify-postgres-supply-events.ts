/**
 * Workflow spine §9 step 9a: supply events.
 *
 *   1. StockMoved: every ledger entry emits one, from every path (adjustment,
 *      reservation, release, consumption, transfer out/in, cancelled
 *      transfer, issue), with the movement type and deltas, never the reason
 *      text or notes; an idempotent replay posts nothing and emits nothing.
 *   2. StockBelowReorder: only the entry that takes the location's balance from
 *      at-or-above the reorder point to below it; task-generator opens one
 *      STOCK_REORDER task for procurement while one is open, a new one after.
 *   3. Stock documents: StockDocumentStatusChanged with documentType for an
 *      adjustment approved or rejected, a stock take completed (variance
 *      lines counted; each variance posts StockMoved) and a goods receipt
 *      rejected; GoodsReceived when one is approved (its lines post RECEIPT).
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-supply-events.ts
 */
import { prisma } from "../src/lib/db";
import { createItem } from "../src/lib/hospital/inventory/items";
import { createStockLocation } from "../src/lib/hospital/inventory/locations";
import { createAdjustment, approveAdjustment, rejectAdjustment } from "../src/lib/hospital/inventory/adjustment";
import { startStockTake, addStockTakeLine, completeStockTake } from "../src/lib/hospital/inventory/stocktake";
import { createSupplier } from "../src/lib/hospital/procurement/suppliers";
import { createPurchaseOrderDraft, addPurchaseOrderLine, submitForApproval, approvePurchaseOrder } from "../src/lib/hospital/procurement/purchaseOrders";
import { recordGoodsReceipt, approveGoodsReceipt, rejectGoodsReceipt } from "../src/lib/hospital/procurement/goodsReceipts";
import { reserveStock, releaseReservation, consumeReservation } from "../src/lib/hospital/inventory/reservation";
import { initiateTransfer, receiveTransfer, cancelTransfer } from "../src/lib/hospital/inventory/transfer";
import { issueStock } from "../src/lib/hospital/inventory/issue";
import { staffAtFacilityWhere } from "../src/lib/auth/staffFacility";
import { runTick } from "../src/lib/runner/tick";
import { completeTask } from "../src/lib/hospital/task";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
type Payload = Record<string, unknown>;

async function main() {
  const run = Date.now().toString(36);
  const facilityId = "fac-amc-pune";
  const staff = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { AND: [staffAtFacilityWhere(facilityId), { user: { role: { in: ["PHARMACIST", "HOSPITAL_ADMIN"] } } }] }, orderBy: { id: "asc" } });
  const by = staff.userId;
  type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
  const tx = <T>(fn: (t: Tx) => Promise<T>) => prisma.$transaction(fn);
  const [store, ward] = await tx(async (t) => [
    await createStockLocation(t, { facilityId, name: `Supply store ${run}`, type: "STORE" }),
    await createStockLocation(t, { facilityId, name: `Supply ward ${run}`, type: "WARD_STORE" }),
  ]);
  const item = await tx((t) => createItem(t, { facilityId, sku: `SUP-${run}`, name: `Supply gloves ${run}`, category: "CONSUMABLE", baseUnit: "PIECE", reorderPoint: 10, reorderQuantity: 50 }));
  const lot = await prisma.itemLot.create({ data: { itemId: item.id, facilityId, lotNumber: `SUP-LOT-${run}`, status: "ACTIVE", expiresAt: new Date("2030-01-01") } });
  const moves = async (sinceSeq: bigint) => (await prisma.domainEventOutbox.findMany({ where: { eventType: "StockMoved", aggregateId: lot.id, seq: { gt: sinceSeq } }, orderBy: { seq: "asc" } })).map((e) => e.payload as Payload);
  const lastSeq = async () => (await prisma.domainEventOutbox.findFirst({ orderBy: { seq: "desc" }, select: { seq: true } }))?.seq ?? BigInt(0);
  const all: Payload[] = [];

  // 1. StockMoved from every ledger path.
  let mark = await lastSeq();
  await tx((t) => createAdjustment(t, { facilityId, itemId: item.id, lotId: lot.id, locationId: store.id, quantityDelta: 40, reason: "FOUND", notes: `found secret ${run}`, requestedByStaffId: staff.id, actorUserId: by, idempotencyKey: `sup-adj-${run}` }));
  let m = await moves(mark); all.push(...m);
  report("An adjustment emits StockMoved (ADJUSTMENT, +40, FOUND, the source document)",
    m.length === 1 && m[0].movementType === "ADJUSTMENT" && m[0].onHandDelta === 40 && m[0].adjustmentReason === "FOUND" && m[0].sourceType === "StockAdjustment" && m[0].locationId === store.id);

  mark = await lastSeq();
  const r1 = await tx((t) => reserveStock(t, { facilityId, itemId: item.id, locationId: store.id, quantity: 5, lotId: lot.id, requestedByStaffId: staff.id, actorUserId: by, idempotencyKey: `sup-res1-${run}` }));
  const r2 = await tx((t) => reserveStock(t, { facilityId, itemId: item.id, locationId: store.id, quantity: 3, lotId: lot.id, requestedByStaffId: staff.id, actorUserId: by, idempotencyKey: `sup-res2-${run}` }));
  await tx((t) => releaseReservation(t, r1.reservation.id, { byUserId: by }));
  await tx((t) => consumeReservation(t, r2.reservation.id, { actorUserId: by, sourceType: "DepartmentSupplyRequest", sourceId: `sup-req-${run}` }));
  m = await moves(mark); all.push(...m);
  report("Reserve, release and consume each emit StockMoved with their deltas",
    m.map((p) => `${p.movementType}:${p.onHandDelta}/${p.reservedDelta}`).join() === "RESERVATION:0/5,RESERVATION:0/3,RELEASE:0/-5,ISSUE:-3/-3", m.map((p) => `${p.movementType}:${p.onHandDelta}/${p.reservedDelta}`).join());

  mark = await lastSeq();
  const t1 = await tx((t) => initiateTransfer(t, { facilityId, itemId: item.id, lotId: lot.id, fromLocationId: store.id, toLocationId: ward.id, quantity: 6, requestedByStaffId: staff.id, actorUserId: by, reason: `restock secret ${run}`, idempotencyKey: `sup-tr1-${run}` }));
  await tx((t) => receiveTransfer(t, t1.transfer.id, { receivedByStaffId: staff.id, actorUserId: by }));
  const t2 = await tx((t) => initiateTransfer(t, { facilityId, itemId: item.id, lotId: lot.id, fromLocationId: store.id, toLocationId: ward.id, quantity: 2, requestedByStaffId: staff.id, actorUserId: by, idempotencyKey: `sup-tr2-${run}` }));
  await tx((t) => cancelTransfer(t, t2.transfer.id, { reason: `not needed secret ${run}`, actorUserId: by }));
  m = await moves(mark); all.push(...m);
  report("A transfer emits TRANSFER_OUT then TRANSFER_IN (at the destination); a cancelled one RETURNs its stock to the source",
    m.map((p) => `${p.movementType}:${p.onHandDelta}@${p.locationId === ward.id ? "ward" : "store"}`).join() === "TRANSFER_OUT:-6@store,TRANSFER_IN:6@ward,TRANSFER_OUT:-2@store,RETURN:2@store",
    m.map((p) => `${p.movementType}:${p.onHandDelta}@${p.locationId === ward.id ? "ward" : "store"}`).join());

  mark = await lastSeq();
  const issue = { facilityId, itemId: item.id, locationId: ward.id, quantity: 4, lotId: lot.id, requestedByStaffId: staff.id, actorUserId: by, sourceType: "DepartmentSupplyRequest", sourceId: `sup-issue-${run}` };
  await tx((t) => issueStock(t, issue));
  await tx((t) => issueStock(t, issue)); // replay
  m = await moves(mark); all.push(...m);
  report("An issue emits StockMoved once; its idempotent replay posts nothing and emits nothing",
    m.length === 1 && m[0].movementType === "ISSUE" && m[0].onHandDelta === -4 && (await prisma.stockLedgerEntry.count({ where: { sourceType: "DepartmentSupplyRequest", sourceId: `sup-issue-${run}` } })) === 1);

  const ledger = await prisma.stockLedgerEntry.count({ where: { lotId: lot.id } });
  const events = await prisma.domainEventOutbox.count({ where: { eventType: "StockMoved", aggregateId: lot.id } });
  report("One StockMoved per ledger entry of the lot, each naming its entry", ledger === events && all.every((p) => typeof p.ledgerEntryId === "string"), `${ledger} entries, ${events} events`);
  report("No StockMoved payload carries reason text or notes", !JSON.stringify(all).includes("secret"));

  // 2. Reorder point (10) at the store, which holds 31 after section 1.
  const drain = async () => { for (let i = 0; i < 6; i++) if (!(await runTick({ budgetMs: 20_000 })).moreWork) break; };
  const below = () => prisma.domainEventOutbox.findMany({ where: { eventType: "StockBelowReorder", aggregateId: item.id }, orderBy: { seq: "asc" } });
  const reorderTasks = () => prisma.task.findMany({ where: { facilityId, type: "STOCK_REORDER", idempotencyKey: { startsWith: `STOCK_REORDER:${item.id}:${store.id}:` } }, orderBy: { createdAt: "asc" } });
  let n = 0;
  const take = (quantity: number) => tx((t) => issueStock(t, { ...issue, locationId: store.id, quantity, sourceId: `sup-take-${run}-${++n}` }));
  await take(21); // 31 → 10: at the point, not below
  report("Down to exactly the reorder point: no StockBelowReorder", (await below()).length === 0);
  await take(1); // 10 → 9: crosses
  await take(1); // 9 → 8: already below
  const b1 = await below();
  const bp = b1[0]?.payload as Payload | undefined;
  report("The entry that crosses below emits StockBelowReorder once (balance 9, point 10); a further decrease emits nothing",
    b1.length === 1 && bp?.onHandQty === 9 && bp.reorderPoint === 10 && bp.locationId === store.id && bp.reorderQuantity === 50);
  await drain();
  let tasks = await reorderTasks();
  report("task-generator opens one STOCK_REORDER task for procurement", tasks.length === 1 && tasks[0].status === "OPEN" && tasks[0].assignedRole === "PROCUREMENT_OFFICER");
  await tx((t) => createAdjustment(t, { facilityId, itemId: item.id, lotId: lot.id, locationId: store.id, quantityDelta: 20, reason: "FOUND", requestedByStaffId: staff.id, actorUserId: by, idempotencyKey: `sup-adj2-${run}` }));
  await take(20); // 28 → 8: crosses again
  await drain();
  tasks = await reorderTasks();
  report("Replenished and crossing again while the task is open: a second event, no second task", (await below()).length === 2 && tasks.length === 1);
  await completeTask({ taskId: tasks[0].id, facilityId, byUserId: by });
  await tx((t) => createAdjustment(t, { facilityId, itemId: item.id, lotId: lot.id, locationId: store.id, quantityDelta: 20, reason: "FOUND", requestedByStaffId: staff.id, actorUserId: by, idempotencyKey: `sup-adj3-${run}` }));
  await take(20); // 28 → 8
  await drain();
  tasks = await reorderTasks();
  report("…once that task is done, the next crossing opens a new one", tasks.length === 2 && tasks[1].status === "OPEN");

  // 3. Stock documents.
  const checker = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { AND: [staffAtFacilityWhere(facilityId), { id: { not: staff.id } }, { user: { role: { in: ["HOSPITAL_ADMIN", "PHARMACIST", "PROCUREMENT_OFFICER"] } } }] }, orderBy: { id: "asc" } });
  const docEvents = async (documentId: string) => (await prisma.domainEventOutbox.findMany({ where: { eventType: "StockDocumentStatusChanged", aggregateId: documentId }, orderBy: { seq: "asc" } })).map((e) => e.payload as Payload);
  const big = await tx((t) => createAdjustment(t, { facilityId, itemId: item.id, lotId: lot.id, locationId: store.id, quantityDelta: 60, reason: "FOUND", requestedByStaffId: staff.id, actorUserId: by, idempotencyKey: `sup-big-${run}` }));
  const bigMoves = await prisma.domainEventOutbox.count({ where: { eventType: "StockMoved", payload: { path: ["sourceId"], equals: big.adjustment.id } } });
  await tx((t) => approveAdjustment(t, big.adjustment.id, { approvedByStaffId: checker.id, actorUserId: checker.userId }));
  const approved = await docEvents(big.adjustment.id);
  report("A high-impact adjustment waits for approval (no StockMoved yet); approval → StockDocumentStatusChanged ADJUSTMENT PENDING_APPROVAL>APPROVED, plus its StockMoved",
    big.adjustment.status === "PENDING_APPROVAL" && bigMoves === 0 && approved.length === 1 && approved[0].documentType === "ADJUSTMENT" && approved[0].from === "PENDING_APPROVAL" && approved[0].to === "APPROVED"
      && (await prisma.domainEventOutbox.count({ where: { eventType: "StockMoved", payload: { path: ["sourceId"], equals: big.adjustment.id } } })) === 1);
  const big2 = await tx((t) => createAdjustment(t, { facilityId, itemId: item.id, lotId: lot.id, locationId: store.id, quantityDelta: -55, reason: "LOSS", requestedByStaffId: staff.id, actorUserId: by, idempotencyKey: `sup-big2-${run}` }));
  await tx((t) => rejectAdjustment(t, big2.adjustment.id, { rejectionReason: `not verified secret ${run}`, actorUserId: checker.userId }));
  const rej = await docEvents(big2.adjustment.id);
  report("A rejected adjustment → PENDING_APPROVAL>REJECTED, no stock moved, no reason text",
    rej.length === 1 && rej[0].to === "REJECTED" && !JSON.stringify(rej).includes("secret")
      && (await prisma.domainEventOutbox.count({ where: { eventType: "StockMoved", payload: { path: ["sourceId"], equals: big2.adjustment.id } } })) === 0);

  const count = await tx((t) => startStockTake(t, { facilityId, locationId: ward.id, startedByStaffId: staff.id }));
  await tx((t) => addStockTakeLine(t, count.id, { itemId: item.id, lotId: lot.id, countedQuantity: 1 }));
  await tx((t) => completeStockTake(t, count.id, { completedByStaffId: staff.id, actorUserId: by }));
  const tk = await docEvents(count.id);
  const varianceAdjustments = (await prisma.stockTakeLine.findMany({ where: { stockTakeId: count.id }, select: { resultingAdjustmentId: true } })).map((l) => l.resultingAdjustmentId).filter((x): x is string => !!x);
  report("A completed stock take → STOCK_TAKE IN_PROGRESS>COMPLETED with its variance line count; the variance posts StockMoved",
    tk.length === 1 && tk[0].documentType === "STOCK_TAKE" && tk[0].to === "COMPLETED" && tk[0].varianceLineCount === 1
      && (await prisma.domainEventOutbox.count({ where: { eventType: "StockMoved", payload: { path: ["sourceId"], equals: varianceAdjustments[0] ?? "-" } } })) === 1, JSON.stringify(tk[0]));

  const supplier = await tx((t) => createSupplier(t, { facilityId, name: `Supply gate supplier ${run}`, code: `SGS-${run}` }));
  const po = await tx(async (t) => {
    const d = await createPurchaseOrderDraft(t, { facilityId, supplierId: supplier.id, createdByStaffId: staff.id });
    await addPurchaseOrderLine(t, d.id, { itemId: item.id, orderedQuantity: 30, unit: "PIECE", unitPriceMinor: 500, taxPercent: 5 });
    return approvePurchaseOrder(t, (await submitForApproval(t, d.id)).id, { approvedByStaffId: checker.id });
  });
  const poLine = await prisma.purchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: po.id } });
  const grn = (key: string, qty: number) => tx((t) => recordGoodsReceipt(t, {
    facilityId, purchaseOrderId: po.id, recordedByStaffId: staff.id, idempotencyKey: `sup-grn-${key}-${run}`,
    lines: [{ purchaseOrderLineId: poLine.id, itemId: item.id, lotNumber: `GRN-${key}-${run}`, expiresAt: new Date("2029-01-01"), acceptedQuantity: qty, locationId: store.id, unit: "PIECE" }],
  }));
  const g1 = await grn("a", 20);
  report("Recording a goods receipt emits nothing yet (a process step)", (await prisma.domainEventOutbox.count({ where: { eventType: { in: ["GoodsReceived", "StockDocumentStatusChanged"] }, aggregateId: g1.receipt.id } })) === 0);
  await tx((t) => approveGoodsReceipt(t, g1.receipt.id, { approvedByStaffId: checker.id, actorUserId: checker.userId }));
  const received = await prisma.domainEventOutbox.findMany({ where: { eventType: "GoodsReceived", aggregateId: g1.receipt.id } });
  const rp = received[0]?.payload as Payload | undefined;
  const g1Line = await prisma.goodsReceiptLine.findFirstOrThrow({ where: { goodsReceiptId: g1.receipt.id } });
  report("Approving it → GoodsReceived (purchase order, supplier, lines), and its line posts a RECEIPT StockMoved",
    received.length === 1 && rp?.purchaseOrderId === po.id && rp.supplierId === supplier.id && rp.lineCount === 1 && rp.acceptedLineCount === 1
      && (await prisma.domainEventOutbox.count({ where: { eventType: "StockMoved", payload: { path: ["sourceId"], equals: g1Line.id } } })) === 1);
  const g2 = await grn("b", 5);
  await tx((t) => rejectGoodsReceipt(t, g2.receipt.id, { rejectedByStaffId: checker.id, reason: `damaged secret ${run}`, actorUserId: checker.userId }));
  const g2e = await docEvents(g2.receipt.id);
  report("Rejecting one → GOODS_RECEIPT RECORDED>REJECTED (no reason text), and no GoodsReceived",
    g2e.length === 1 && g2e[0].documentType === "GOODS_RECEIPT" && g2e[0].to === "REJECTED" && !JSON.stringify(g2e).includes("secret")
      && (await prisma.domainEventOutbox.count({ where: { eventType: "GoodsReceived", aggregateId: g2.receipt.id } })) === 0);

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
