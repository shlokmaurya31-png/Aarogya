/**
 * Workflow spine §9 step 9a: supply events.
 *
 *   1. StockMoved: every ledger entry emits one, from every path (adjustment,
 *      reservation, release, consumption, transfer out/in, cancelled
 *      transfer, issue), with the movement type and deltas, never the reason
 *      text or notes; an idempotent replay posts nothing and emits nothing.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-supply-events.ts
 */
import { prisma } from "../src/lib/db";
import { createItem } from "../src/lib/hospital/inventory/items";
import { createStockLocation } from "../src/lib/hospital/inventory/locations";
import { createAdjustment } from "../src/lib/hospital/inventory/adjustment";
import { reserveStock, releaseReservation, consumeReservation } from "../src/lib/hospital/inventory/reservation";
import { initiateTransfer, receiveTransfer, cancelTransfer } from "../src/lib/hospital/inventory/transfer";
import { issueStock } from "../src/lib/hospital/inventory/issue";
import { staffAtFacilityWhere } from "../src/lib/auth/staffFacility";

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

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
