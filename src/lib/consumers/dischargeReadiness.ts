import { prisma } from "@/lib/db";
import type { DomainEventConsumer } from "@/lib/events/consumers";
import { PermanentEventError } from "@/lib/events/types";
import { updateDischargeReadiness } from "@/lib/hospital/admission";
import { recordAuditEvent } from "@/lib/auth/audit";

/**
 * discharge-readiness (workflow spine §2): derives the three readiness flags
 * that are a pure function of recorded facts, for an encounter with a
 * discharge in progress, through updateDischargeReadiness.
 *
 *   documentationReady  a final (not draft) discharge summary was generated
 *   billingReady        every posted charge is priced and on an issued
 *                       document, there is at least one, and each issued
 *                       document is paid or carried by a live claim
 *   insuranceReady      no active coverage; or no pre-authorization still
 *                       awaiting a decision, and an approved one or a live
 *                       claim for every issued document
 *
 * Raise-only: a flag is set when its condition holds and is never cleared
 * here. Staff set all six flags by hand (finalizeDischarge requires them),
 * and bed-day charges are posted at finalize, so an absolute recompute would
 * take back flags a person set and block every discharge before its final
 * bill. Raising is order-independent, so redelivery and reordering converge.
 * clinicallyReady, pharmacyReady and transportReady stay human decisions
 * (nothing recorded says take-home medication is complete). Pending results
 * and consults are not flags: the barrier engine computes them on read.
 */
const LIVE_CLAIM = ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "PARTIALLY_APPROVED", "SETTLED"] as const;
const ISSUED = ["ISSUED", "PARTIALLY_PAID", "PAID"] as const;

type Flag = "documentationReady" | "billingReady" | "insuranceReady";

async function derive(encounterId: string, patientId: string): Promise<Record<Flag, boolean>> {
  const [summary, unbilled, invoices, coverage, pendingPreAuth, approvedPreAuth] = await Promise.all([
    prisma.clinicalDocument.count({ where: { encounterId, generatedDocument: { type: "discharge-summary", isDraft: false } } }),
    prisma.charge.count({ where: { encounterId, status: "POSTED", OR: [{ pricingStatus: "NEEDS_PRICING" }, { invoiceLine: null }, { invoiceLine: { invoice: { status: { notIn: [...ISSUED] } } } }] } }),
    prisma.invoice.findMany({
      where: { encounterId, status: { in: [...ISSUED] } },
      select: { status: true, claim: { select: { status: true, settledAt: true } } },
    }),
    prisma.patientCoverage.count({ where: { patientId, status: "ACTIVE", validFrom: { lte: new Date() }, OR: [{ validTo: null }, { validTo: { gte: new Date() } }] } }),
    prisma.preAuthorization.count({ where: { encounterId, status: "REQUESTED" } }),
    prisma.preAuthorization.count({ where: { encounterId, status: "APPROVED" } }),
  ]);
  const liveClaim = (c: { status: string; settledAt: Date | null } | null) =>
    !!c && ((LIVE_CLAIM as readonly string[]).includes(c.status) || (c.status === "CLOSED" && c.settledAt !== null));
  const everyClaimed = invoices.length > 0 && invoices.every((i) => liveClaim(i.claim));
  return {
    documentationReady: summary > 0,
    billingReady: unbilled === 0 && invoices.length > 0 && invoices.every((i) => i.status === "PAID" || liveClaim(i.claim)),
    insuranceReady: coverage === 0 || (pendingPreAuth === 0 && (approvedPreAuth > 0 || everyClaimed)),
  };
}

export const dischargeReadiness: DomainEventConsumer = {
  name: "discharge-readiness",
  handles: [
    "DischargeInitiated", "DocumentGenerated", "ChargePosted", "ChargeRepriced", "ChargeWaived", "ChargeVoided",
    "HospitalInvoiceIssued", "HospitalInvoiceVoided", "HospitalPaymentStatusChanged",
    "ClaimDrafted", "ClaimStatusChanged", "ClaimSettled", "PreauthDecided", "PreauthStatusChanged", "CoverageStatusChanged",
  ],
  async handle(event) {
    const p = event.payload as { encounterId?: string; patientId?: string };
    // Coverage is the patient's, not an encounter's: their discharges in progress at the event's facility.
    const where = event.eventType === "CoverageStatusChanged"
      ? { dischargedAt: null, admission: { encounter: { patientId: String(p.patientId), facilityId: event.facilityId ?? "" } } }
      : p.encounterId ? { dischargedAt: null, admission: { encounterId: p.encounterId } } : null;
    if (!where) return; // a document without an encounter
    const discharges = await prisma.discharge.findMany({
      where,
      select: { id: true, documentationReady: true, billingReady: true, insuranceReady: true, admission: { select: { encounter: { select: { id: true, facilityId: true, patientId: true } } } } },
    });
    for (const d of discharges) {
      const enc = d.admission.encounter;
      if (enc.facilityId !== event.facilityId) throw new PermanentEventError(`Encounter ${enc.id} is not in the event's facility.`, "TENANT_MISMATCH");
      const derived = await derive(enc.id, enc.patientId);
      const raise = (Object.keys(derived) as Flag[]).filter((f) => derived[f] && !d[f]);
      if (!raise.length) continue;
      await updateDischargeReadiness(d.id, Object.fromEntries(raise.map((f) => [f, true])));
      await recordAuditEvent("hospital.discharge.readinessDerived", null, { dischargeId: d.id, flags: raise, eventType: event.eventType },
        { facilityId: enc.facilityId, patientId: enc.patientId, encounterId: enc.id });
    }
  },
};
