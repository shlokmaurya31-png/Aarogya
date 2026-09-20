import { prisma } from "@/lib/db";
import { safeSection } from "./section";
import { nextAppointment } from "./appointments";
import { listQueuePositions } from "./queue";
import { billingSummary } from "./billing";
import { listReports } from "./reports";
import type { PatientAccessScope } from "../context";

/**
 * Phase D11 — the patient home (brief §8, §58). Deliberately SMALL: what is
 * happening, what needs attention, what happened recently, what comes next.
 * Every section is error-isolated (brief §35) — a failed subsystem shows
 * UNAVAILABLE, never a false "no appointments" / "₹0 due".
 */

export async function buildHome(scope: PatientAccessScope, patientName: string) {
  const [next, queue, billing, reports] = await Promise.all([
    safeSection(() => nextAppointment(scope)),
    safeSection(() => listQueuePositions(scope)),
    safeSection(() => billingSummary(scope)),
    safeSection(async () => (await listReports(scope)).slice(0, 3)),
  ]);

  // A tiny "action required" list, honestly derived (no fabricated nudges).
  const actions: string[] = [];
  if (billing.status === "OK" && billing.data.outstandingMinor > 0) {
    actions.push(`You have a pending bill of ₹${Math.round(billing.data.outstandingMinor / 100)}.`);
  }
  const pendingConsents = await safeSection(async () =>
    prisma.interopConsent.count({ where: { patientId: scope.patientId, status: "REQUESTED" } }),
  );
  if (pendingConsents.status === "OK" && pendingConsents.data > 0) {
    actions.push(`You have ${pendingConsents.data} consent request${pendingConsents.data > 1 ? "s" : ""} awaiting your decision.`);
  }

  return {
    patientName,
    isSelf: scope.isSelf,
    nextAppointment: next,
    queue,
    billing,
    recentReports: reports,
    actionsRequired: actions,
  };
}
