/**
 * Phase 6A manual verification: proves the inventory-engine concurrency
 * invariants (races 1, 2, 4, 5, 6 of the required 8) hold against a real
 * PostgreSQL instance under genuine concurrent races — not sequential
 * requests. Mirrors scripts/verify-postgres-billing-concurrency.ts's exact
 * structure (this codebase has no automated DB-backed test harness
 * anywhere, by established convention).
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-inventory-concurrency.ts
 */
import { PrismaClient } from "@prisma/client";
import { issueStock } from "../src/lib/hospital/inventory/issue";
import { InsufficientStockError } from "../src/lib/hospital/inventory/stockBalance";
import { reserveStock } from "../src/lib/hospital/inventory/reservation";
import { initiateTransfer, receiveTransfer, TransferConcurrencyError } from "../src/lib/hospital/inventory/transfer";
import { createAdjustment } from "../src/lib/hospital/inventory/adjustment";
import { getOrCreateStockBalance } from "../src/lib/hospital/inventory/stockBalance";

const prisma = new PrismaClient();
const runId = Date.now();

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

async function freshItem(facilityId: string, name: string) {
  return prisma.item.create({ data: { facilityId, sku: `VERIFY-${name}-${runId}-${Math.random().toString(36).slice(2)}`, name, category: "CONSUMABLE", baseUnit: "PIECE" } });
}
async function freshLocation(facilityId: string, name: string) {
  return prisma.stockLocation.create({ data: { facilityId, name: `${name}-${runId}-${Math.random().toString(36).slice(2)}`, type: "WAREHOUSE" } });
}
async function freshLot(itemId: string, facilityId: string, lotNumber: string) {
  return prisma.itemLot.create({ data: { itemId, facilityId, lotNumber: `${lotNumber}-${runId}`, status: "ACTIVE" } });
}
async function seedBalance(facilityId: string, itemId: string, lotId: string, locationId: string, onHandQty: number) {
  const balance = await prisma.$transaction((tx) => getOrCreateStockBalance(tx, { facilityId, itemId, lotId, locationId }));
  await prisma.stockBalance.update({ where: { id: balance.id }, data: { onHandQty } });
  return balance;
}

async function main() {
  const facility = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Medical Centre" } });
  const staff = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { facilityId: facility.id, user: { role: "PHARMACIST" } } });

  // 1. Genuine parallel race: two concurrent issues for the last 5 units — exactly one succeeds.
  {
    const item = await freshItem(facility.id, "Race1Item");
    const location = await freshLocation(facility.id, "Race1Loc");
    const lot = await freshLot(item.id, facility.id, "R1");
    await seedBalance(facility.id, item.id, lot.id, location.id, 5);

    const attempt = (n: number) =>
      prisma
        .$transaction((tx) =>
          issueStock(tx, { facilityId: facility.id, itemId: item.id, locationId: location.id, quantity: 5, lotId: lot.id, requestedByStaffId: staff.id, actorUserId: staff.userId, sourceType: "VerifyRace1", sourceId: `race1-${n}-${runId}` })
        )
        .then(() => ({ ok: true as const }))
        .catch((err) => ({ ok: false as const, err }));

    const [r1, r2] = await Promise.all([attempt(1), attempt(2)]);
    const successes = [r1, r2].filter((r) => r.ok).length;
    const conflicts = [r1, r2].filter((r) => !r.ok && r.err instanceof InsufficientStockError).length;
    report("Race 1 — last-5-units concurrent issue: exactly one succeeds, no negative stock", successes === 1 && conflicts === 1, `successes=${successes} conflicts=${conflicts}`);
    const finalBalance = await prisma.stockBalance.findFirstOrThrow({ where: { itemId: item.id, lotId: lot.id, locationId: location.id } });
    report("Race 1 — final onHandQty is exactly 0, never negative", finalBalance.onHandQty === 0, `onHandQty=${finalBalance.onHandQty}`);
  }

  // 2. Genuine parallel race: two concurrent reservations for the last available unit — exactly one succeeds.
  {
    const item = await freshItem(facility.id, "Race2Item");
    const location = await freshLocation(facility.id, "Race2Loc");
    const lot = await freshLot(item.id, facility.id, "R2");
    await seedBalance(facility.id, item.id, lot.id, location.id, 3);

    const attempt = (n: number) =>
      prisma
        .$transaction((tx) =>
          reserveStock(tx, { facilityId: facility.id, itemId: item.id, locationId: location.id, quantity: 3, lotId: lot.id, requestedByStaffId: staff.id, actorUserId: staff.userId, idempotencyKey: `race2-${n}-${runId}` })
        )
        .then((r) => ({ ok: true as const, r }))
        .catch((err) => ({ ok: false as const, err }));

    const [r1, r2] = await Promise.all([attempt(1), attempt(2)]);
    const successes = [r1, r2].filter((r) => r.ok).length;
    report("Race 2 — last-available-unit concurrent reservation: exactly one succeeds", successes === 1, `successes=${successes}`);
    const finalBalance = await prisma.stockBalance.findFirstOrThrow({ where: { itemId: item.id, lotId: lot.id, locationId: location.id } });
    report("Race 2 — reservedQty never exceeds onHandQty", finalBalance.reservedQty <= finalBalance.onHandQty, `onHand=${finalBalance.onHandQty} reserved=${finalBalance.reservedQty}`);
  }

  // 4. Genuine parallel race: two competing transfers from the same source stock — exactly one succeeds.
  {
    const item = await freshItem(facility.id, "Race4Item");
    const source = await freshLocation(facility.id, "Race4Src");
    const destA = await freshLocation(facility.id, "Race4DestA");
    const destB = await freshLocation(facility.id, "Race4DestB");
    const lot = await freshLot(item.id, facility.id, "R4");
    await seedBalance(facility.id, item.id, lot.id, source.id, 10);

    const attempt = (n: number, toLocationId: string) =>
      prisma
        .$transaction((tx) =>
          initiateTransfer(tx, { facilityId: facility.id, itemId: item.id, lotId: lot.id, fromLocationId: source.id, toLocationId, quantity: 10, requestedByStaffId: staff.id, actorUserId: staff.userId, idempotencyKey: `race4-${n}-${runId}` })
        )
        .then(() => ({ ok: true as const }))
        .catch((err) => ({ ok: false as const, err }));

    const [r1, r2] = await Promise.all([attempt(1, destA.id), attempt(2, destB.id)]);
    const successes = [r1, r2].filter((r) => r.ok).length;
    report("Race 4 — competing transfer of the same 10 units: exactly one succeeds, no stock duplication", successes === 1, `successes=${successes}`);
  }

  // 5. Genuine parallel race: the same transfer received twice concurrently — exactly one succeeds.
  {
    const item = await freshItem(facility.id, "Race5Item");
    const source = await freshLocation(facility.id, "Race5Src");
    const dest = await freshLocation(facility.id, "Race5Dest");
    const lot = await freshLot(item.id, facility.id, "R5");
    await seedBalance(facility.id, item.id, lot.id, source.id, 10);
    const { transfer } = await prisma.$transaction((tx) =>
      initiateTransfer(tx, { facilityId: facility.id, itemId: item.id, lotId: lot.id, fromLocationId: source.id, toLocationId: dest.id, quantity: 10, requestedByStaffId: staff.id, actorUserId: staff.userId, idempotencyKey: `race5-init-${runId}` })
    );

    const attempt = () =>
      prisma
        .$transaction((tx) => receiveTransfer(tx, transfer.id, { receivedByStaffId: staff.id, actorUserId: staff.userId }))
        .then(() => ({ ok: true as const }))
        .catch((err) => ({ ok: false as const, err }));

    const [r1, r2] = await Promise.all([attempt(), attempt()]);
    const successes = [r1, r2].filter((r) => r.ok).length;
    const conflicts = [r1, r2].filter((r) => !r.ok && r.err instanceof TransferConcurrencyError).length;
    report("Race 5 — same transfer received twice concurrently: exactly one succeeds, no double receipt", successes === 1 && conflicts === 1, `successes=${successes} conflicts=${conflicts}`);
    const destBalance = await prisma.stockBalance.findFirstOrThrow({ where: { itemId: item.id, lotId: lot.id, locationId: dest.id } });
    report("Race 5 — destination onHandQty is exactly 10, not doubled to 20", destBalance.onHandQty === 10, `onHandQty=${destBalance.onHandQty}`);
  }

  // 6. Genuine parallel race: two concurrent normal-impact adjustments against the same stock position — no corruption.
  {
    const item = await freshItem(facility.id, "Race6Item");
    const location = await freshLocation(facility.id, "Race6Loc");
    const lot = await freshLot(item.id, facility.id, "R6");
    await seedBalance(facility.id, item.id, lot.id, location.id, 10);

    const attempt = (n: number) =>
      prisma
        .$transaction((tx) =>
          createAdjustment(tx, { facilityId: facility.id, itemId: item.id, lotId: lot.id, locationId: location.id, quantityDelta: -5, reason: "COUNT_CORRECTION", requestedByStaffId: staff.id, actorUserId: staff.userId, idempotencyKey: `race6-${n}-${runId}` })
        )
        .then(() => ({ ok: true as const }))
        .catch((err) => ({ ok: false as const, err }));

    const [r1, r2] = await Promise.all([attempt(1), attempt(2)]);
    const successes = [r1, r2].filter((r) => r.ok).length;
    report("Race 6 — two concurrent -5 adjustments against 10 on-hand: both succeed (exactly covers to 0), no corruption", successes === 2, `successes=${successes}`);
    const finalBalance = await prisma.stockBalance.findFirstOrThrow({ where: { itemId: item.id, lotId: lot.id, locationId: location.id } });
    report("Race 6 — final onHandQty is exactly 0, never negative", finalBalance.onHandQty === 0, `onHandQty=${finalBalance.onHandQty}`);
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
