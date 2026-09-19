import { prisma } from "@/lib/db";
import type { CommandContext } from "./authz";
import { metric, driver, section } from "./_build";
import type { CommandSection } from "./types";

/**
 * PHARMACY — medication workflow backlog + stock signals from canonical models
 * (MedicationOrder, MedicationAdministration, StockBalance). No second inventory truth:
 * stock-outs are `StockBalance.onHandQty <= 0` counts. Verification backlog is
 * D8-configurable (pharmacyBacklog).
 */
export async function getPharmacy(ctx: CommandContext): Promise<CommandSection> {
  const f = ctx.facilityId;
  const [pendingVerification, held, urgentPending, missedAdmin, dueAdmin, stockouts] = await Promise.all([
    prisma.medicationOrder.count({ where: { encounter: { facilityId: f }, status: "PHARMACY_REVIEW" } }),
    prisma.medicationOrder.count({ where: { encounter: { facilityId: f }, status: "HELD" } }),
    prisma.medicationOrder.count({ where: { encounter: { facilityId: f }, status: "PHARMACY_REVIEW", order: { priority: { in: ["URGENT", "EMERGENCY"] } } } }),
    prisma.medicationAdministration.count({ where: { status: "MISSED", medicationOrder: { encounter: { facilityId: f } } } }),
    prisma.medicationAdministration.count({ where: { status: "DUE", medicationOrder: { encounter: { facilityId: f } } } }),
    prisma.stockBalance.count({ where: { facilityId: f, onHandQty: { lte: 0 } } }),
  ]);

  const metrics = [
    metric({ key: "pharmacyBacklog", label: "Orders pending verification", value: pendingVerification, unit: "orders", timeSemantics: "CURRENT_STATE", threshold: ctx.thresholds.pharmacyBacklog, source: "MedicationOrder" }),
    metric({ key: "pharmacyUrgentPending", label: "Urgent orders pending", value: urgentPending, unit: "orders", timeSemantics: "CURRENT_STATE", status: urgentPending > 0 ? "WARNING" : "NORMAL", source: "MedicationOrder" }),
    metric({ key: "pharmacyMissedAdmin", label: "Missed administrations", value: missedAdmin, unit: "doses", timeSemantics: "CURRENT_STATE", status: missedAdmin > 0 ? "WARNING" : "NORMAL", source: "MedicationAdministration" }),
    metric({ key: "pharmacyStockouts", label: "Stock-out items", value: stockouts, unit: "items", timeSemantics: "CURRENT_STATE", status: stockouts > 0 ? "WATCH" : "NORMAL", source: "StockBalance" }),
  ];
  const drivers = [
    driver("Pending verification", pendingVerification, "DIRECT"),
    driver("Urgent pending", urgentPending, "DIRECT"),
    driver("Held / clarification", held, "CONTRIBUTING"),
    driver("Missed administrations", missedAdmin, "DIRECT"),
    driver("Doses due", dueAdmin, "CONTRIBUTING"),
    driver("Stock-out items", stockouts, "CONTRIBUTING"),
  ];
  return section(ctx, { key: "pharmacy", label: "Pharmacy", metrics, drivers, drillDown: null });
}
