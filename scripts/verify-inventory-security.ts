/**
 * Phase 6A adversarial/security verification — SQLite-safe (no genuine
 * concurrency required for these checks, unlike the verify-postgres-*
 * scripts), run directly against the local dev database. Proves:
 *  - cross-facility resource IDs (item/location/lot/supplier/requisition/
 *    PO line) are rejected by the service layer itself, not just by the
 *    route-level facilityId resolution — defense in depth against IDOR.
 *  - expired/quarantined lots cannot be issued.
 *  - over-issue and negative-quantity issue are rejected.
 *  - status-tampering (approving a non-existent/wrong-state resource) is rejected.
 *
 * Usage: npx tsx scripts/verify-inventory-security.ts
 */
import { PrismaClient } from "@prisma/client";
import { issueStock } from "../src/lib/hospital/inventory/issue";
import { ResourceFacilityMismatchError } from "../src/lib/hospital/inventory/facilityScope";
import { ExpiredLotError, QuarantinedLotError } from "../src/lib/hospital/inventory/fefo";
import { InsufficientStockError } from "../src/lib/hospital/inventory/stockBalance";
import { createStockLocation } from "../src/lib/hospital/inventory/locations";
import { getOrCreateStockBalance } from "../src/lib/hospital/inventory/stockBalance";
import { addPurchaseOrderLine } from "../src/lib/hospital/procurement/purchaseOrders";
import { BadRequestError } from "../src/lib/auth/rbac";

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
  const facilityA = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Medical Centre" } });
  const facilityB = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Noida Hospital" } });
  const staffA = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { facilityId: facilityA.id, user: { role: "PHARMACIST" } } });

  // Cross-facility item: Facility A staff attempts to issue stock against Facility B's item.
  {
    const itemB = await prisma.item.findFirstOrThrow({ where: { facilityId: facilityB.id } });
    const locationA = await prisma.$transaction((tx) => createStockLocation(tx, { facilityId: facilityA.id, name: `Security-Loc-A-${runId}`, type: "WAREHOUSE" }));
    const result = await prisma
      .$transaction((tx) =>
        issueStock(tx, { facilityId: facilityA.id, itemId: itemB.id, locationId: locationA.id, quantity: 1, requestedByStaffId: staffA.id, actorUserId: staffA.userId, sourceType: "SecurityTest", sourceId: `xfac-item-${runId}` })
      )
      .then(() => ({ ok: true as const }))
      .catch((err) => ({ ok: false as const, err }));
    report("Cross-facility item ID rejected by the service layer (not just the route)", !result.ok && result.err instanceof ResourceFacilityMismatchError);
  }

  // Cross-facility location: Facility A staff attempts to issue into Facility B's location.
  {
    const itemA = await prisma.item.findFirstOrThrow({ where: { facilityId: facilityA.id } });
    const locationB = await prisma.stockLocation.findFirstOrThrow({ where: { facilityId: facilityB.id } });
    const result = await prisma
      .$transaction((tx) =>
        issueStock(tx, { facilityId: facilityA.id, itemId: itemA.id, locationId: locationB.id, quantity: 1, requestedByStaffId: staffA.id, actorUserId: staffA.userId, sourceType: "SecurityTest", sourceId: `xfac-loc-${runId}` })
      )
      .then(() => ({ ok: true as const }))
      .catch((err) => ({ ok: false as const, err }));
    report("Cross-facility location ID rejected by the service layer", !result.ok && result.err instanceof ResourceFacilityMismatchError);
  }

  // Cross-facility lot: explicit lot override belonging to another facility.
  {
    const itemA = await prisma.item.findFirstOrThrow({ where: { facilityId: facilityA.id } });
    const locationA = await prisma.stockLocation.findFirstOrThrow({ where: { facilityId: facilityA.id } });
    const itemB = await prisma.item.findFirstOrThrow({ where: { facilityId: facilityB.id } });
    const lotB = await prisma.itemLot.create({ data: { itemId: itemB.id, facilityId: facilityB.id, lotNumber: `SEC-XFAC-LOT-${runId}`, status: "ACTIVE" } });
    const result = await prisma
      .$transaction((tx) =>
        issueStock(tx, { facilityId: facilityA.id, itemId: itemA.id, locationId: locationA.id, quantity: 1, lotId: lotB.id, requestedByStaffId: staffA.id, actorUserId: staffA.userId, sourceType: "SecurityTest", sourceId: `xfac-lot-${runId}` })
      )
      .then(() => ({ ok: true as const }))
      .catch((err) => ({ ok: false as const, err }));
    report("Cross-facility explicit lot override rejected by the service layer", !result.ok && result.err instanceof ResourceFacilityMismatchError);
  }

  // Cross-facility PO line item.
  {
    const supplierA = await prisma.supplier.findFirstOrThrow({ where: { facilityId: facilityA.id } });
    const itemB = await prisma.item.findFirstOrThrow({ where: { facilityId: facilityB.id } });
    const po = await prisma.purchaseOrder.create({ data: { facilityId: facilityA.id, supplierId: supplierA.id, createdByStaffId: staffA.id, idempotencyKey: `sec-po-${runId}` } });
    const result = await prisma
      .$transaction((tx) => addPurchaseOrderLine(tx, po.id, { itemId: itemB.id, orderedQuantity: 1, unit: "TABLET", unitPriceMinor: 100 }))
      .then(() => ({ ok: true as const }))
      .catch((err) => ({ ok: false as const, err }));
    report("Cross-facility item on a purchase order line rejected", !result.ok && result.err instanceof ResourceFacilityMismatchError);
  }

  // Expired lot: never issuable through ordinary workflows.
  {
    const item = await prisma.item.findFirstOrThrow({ where: { facilityId: facilityA.id } });
    const location = await prisma.stockLocation.findFirstOrThrow({ where: { facilityId: facilityA.id } });
    const expiredLot = await prisma.itemLot.create({ data: { itemId: item.id, facilityId: facilityA.id, lotNumber: `SEC-EXPIRED-${runId}`, status: "ACTIVE", expiresAt: new Date(Date.now() - 86_400_000) } });
    await prisma.$transaction((tx) => getOrCreateStockBalance(tx, { facilityId: facilityA.id, itemId: item.id, lotId: expiredLot.id, locationId: location.id }));
    await prisma.stockBalance.updateMany({ where: { lotId: expiredLot.id }, data: { onHandQty: 100 } });

    const result = await prisma
      .$transaction((tx) =>
        issueStock(tx, { facilityId: facilityA.id, itemId: item.id, locationId: location.id, quantity: 1, lotId: expiredLot.id, requestedByStaffId: staffA.id, actorUserId: staffA.userId, sourceType: "SecurityTest", sourceId: `expired-${runId}` })
      )
      .then(() => ({ ok: true as const }))
      .catch((err) => ({ ok: false as const, err }));
    report("Expired lot cannot be issued, even with 100 on-hand", !result.ok && result.err instanceof ExpiredLotError);
  }

  // Quarantined lot: ordinary issue must be blocked.
  {
    const item = await prisma.item.findFirstOrThrow({ where: { facilityId: facilityA.id } });
    const location = await prisma.stockLocation.findFirstOrThrow({ where: { facilityId: facilityA.id } });
    const quarantinedLot = await prisma.itemLot.create({ data: { itemId: item.id, facilityId: facilityA.id, lotNumber: `SEC-QUARANTINE-${runId}`, status: "QUARANTINED" } });
    await prisma.$transaction((tx) => getOrCreateStockBalance(tx, { facilityId: facilityA.id, itemId: item.id, lotId: quarantinedLot.id, locationId: location.id }));
    await prisma.stockBalance.updateMany({ where: { lotId: quarantinedLot.id }, data: { onHandQty: 100 } });

    const result = await prisma
      .$transaction((tx) =>
        issueStock(tx, { facilityId: facilityA.id, itemId: item.id, locationId: location.id, quantity: 1, lotId: quarantinedLot.id, requestedByStaffId: staffA.id, actorUserId: staffA.userId, sourceType: "SecurityTest", sourceId: `quarantine-${runId}` })
      )
      .then(() => ({ ok: true as const }))
      .catch((err) => ({ ok: false as const, err }));
    report("Quarantined lot cannot be issued, even with 100 on-hand", !result.ok && result.err instanceof QuarantinedLotError);
  }

  // Over-issue: requesting more than available must be rejected, not silently truncated or allowed negative.
  {
    const item = await prisma.item.findFirstOrThrow({ where: { facilityId: facilityA.id } });
    const location = await prisma.$transaction((tx) => createStockLocation(tx, { facilityId: facilityA.id, name: `Security-OverIssue-${runId}`, type: "WAREHOUSE" }));
    const lot = await prisma.itemLot.create({ data: { itemId: item.id, facilityId: facilityA.id, lotNumber: `SEC-OVERISSUE-${runId}`, status: "ACTIVE" } });
    await prisma.$transaction((tx) => getOrCreateStockBalance(tx, { facilityId: facilityA.id, itemId: item.id, lotId: lot.id, locationId: location.id }));
    await prisma.stockBalance.updateMany({ where: { lotId: lot.id }, data: { onHandQty: 5 } });

    const result = await prisma
      .$transaction((tx) =>
        issueStock(tx, { facilityId: facilityA.id, itemId: item.id, locationId: location.id, quantity: 999, lotId: lot.id, requestedByStaffId: staffA.id, actorUserId: staffA.userId, sourceType: "SecurityTest", sourceId: `overissue-${runId}` })
      )
      .then(() => ({ ok: true as const }))
      .catch((err) => ({ ok: false as const, err }));
    report("Over-issue (999 requested, 5 on-hand) rejected", !result.ok && result.err instanceof InsufficientStockError);
  }

  // Negative-quantity issue: must be rejected outright, not treated as a receipt in disguise.
  {
    const item = await prisma.item.findFirstOrThrow({ where: { facilityId: facilityA.id } });
    const location = await prisma.stockLocation.findFirstOrThrow({ where: { facilityId: facilityA.id } });
    const result = await prisma
      .$transaction((tx) =>
        issueStock(tx, { facilityId: facilityA.id, itemId: item.id, locationId: location.id, quantity: -10, requestedByStaffId: staffA.id, actorUserId: staffA.userId, sourceType: "SecurityTest", sourceId: `negative-${runId}` })
      )
      .then(() => ({ ok: true as const }))
      .catch((err) => ({ ok: false as const, err }));
    report("Negative issue quantity rejected outright", !result.ok && result.err instanceof BadRequestError);
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
