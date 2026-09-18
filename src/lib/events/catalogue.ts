import { z } from "zod";
import type { EventContract } from "./types";

/**
 * Phase D6 — the event catalogue (in-code schema registry).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Every domain event Aarogya can emit is declared HERE, exactly once, with a
 * versioned, `.strict()` payload contract. This is the single source of truth for:
 *   - which event types + versions are legal (unknown ones are rejected on emit
 *     AND on dispatch/replay — see emit.ts / dispatcher.ts);
 *   - the payload shape (identifiers + minimal metadata only, never PHI/secrets);
 *   - the aggregate, tenant scope, sensitivity, and producing service.
 *
 * Events are CONTRACTS. Never change the meaning of an existing version — add a
 * new version (e.g. PatientRegistered v2) and keep v1. Consumers declare the
 * version they understand. The catalogue is keyed by `${type}@${version}`.
 * ════════════════════════════════════════════════════════════════════════════
 */

// Reusable field helpers. Identifiers are non-empty strings; money is integer
// minor units + an ISO-4217 code (currency is never summed across events).
const id = z.string().min(1);
const optId = z.string().min(1).optional();
const minor = z.number().int();
const currency = z.string().length(3);
const iso = z.string().min(1); // ISO-8601 timestamp string

function contract<P extends z.ZodTypeAny>(c: EventContract<P>): EventContract<P> {
  return c;
}

/**
 * The catalogue. Grouped by domain. Keep payloads minimal — a consumer that needs
 * the full record must load it through the normal authorized APIs.
 */
export const EVENT_CONTRACTS: EventContract[] = [
  // ── Clinical ───────────────────────────────────────────────────────────────
  contract({
    type: "PatientRegistered", version: 1, aggregateType: "PATIENT", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "patient registration",
    payload: z.object({ patientId: id, uhid: optId }).strict(),
  }),
  contract({
    type: "AppointmentBooked", version: 1, aggregateType: "APPOINTMENT", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "scheduling (bookAppointment)",
    payload: z.object({ appointmentId: id, patientId: id, doctorStaffId: id, scheduledStart: iso }).strict(),
  }),
  contract({
    type: "AdmissionCreated", version: 1, aggregateType: "ADMISSION", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "admissions (admitPatient)",
    payload: z.object({ admissionId: id, encounterId: id, patientId: id, bedId: optId }).strict(),
  }),
  contract({
    type: "MedicationOrdered", version: 1, aggregateType: "MEDICATION_ORDER", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "medication lifecycle (createMedicationOrder)",
    payload: z.object({ orderId: id, patientId: id, encounterId: optId }).strict(),
  }),
  contract({
    type: "LabResultReleased", version: 1, aggregateType: "LAB_RESULT", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "lab result lifecycle (verifyResult)",
    payload: z.object({ resultId: id, orderId: optId, patientId: optId, critical: z.boolean().optional() }).strict(),
  }),
  contract({
    type: "ImagingReportReleased", version: 1, aggregateType: "IMAGING_REPORT", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "imaging report lifecycle (verifyReport)",
    payload: z.object({ reportId: id, studyId: optId, patientId: optId, critical: z.boolean().optional() }).strict(),
  }),

  // ── Interoperability ─────────────────────────────────────────────────────────
  contract({
    type: "ConsentGranted", version: 1, aggregateType: "CONSENT", scope: "FACILITY",
    sensitivity: "SENSITIVE", producer: "interoperability consent",
    payload: z.object({ consentId: id, patientId: id }).strict(),
  }),
  contract({
    type: "ConsentRevoked", version: 1, aggregateType: "CONSENT", scope: "FACILITY",
    sensitivity: "SENSITIVE", producer: "interoperability consent",
    payload: z.object({ consentId: id, patientId: id }).strict(),
  }),

  // ── Commercial (D2–D5 canonical services) ────────────────────────────────────
  contract({
    type: "SubscriptionActivated", version: 1, aggregateType: "SUBSCRIPTION", scope: "ORGANIZATION",
    sensitivity: "LOW", producer: "commercial subscriptions (assignPlan)",
    payload: z.object({ subscriptionId: id, planId: id, billingInterval: id }).strict(),
  }),
  contract({
    type: "SubscriptionRenewed", version: 1, aggregateType: "SUBSCRIPTION", scope: "ORGANIZATION",
    sensitivity: "LOW", producer: "commercial subscriptions (applyPaidRenewal)",
    payload: z.object({ subscriptionId: id, periodStart: iso, periodEnd: iso }).strict(),
  }),
  contract({
    type: "SubscriptionCancelled", version: 1, aggregateType: "SUBSCRIPTION", scope: "ORGANIZATION",
    sensitivity: "LOW", producer: "commercial subscriptions (cancelSubscription)",
    payload: z.object({ subscriptionId: id, immediate: z.boolean() }).strict(),
  }),
  contract({
    type: "InvoiceCreated", version: 1, aggregateType: "INVOICE", scope: "ORGANIZATION",
    sensitivity: "LOW", producer: "billing invoices (generateInvoiceForPeriod)",
    payload: z.object({ invoiceId: id, totalMinor: minor, currency }).strict(),
  }),
  contract({
    type: "InvoiceFinalized", version: 1, aggregateType: "INVOICE", scope: "ORGANIZATION",
    sensitivity: "LOW", producer: "billing invoices (finalizeInvoiceTx)",
    payload: z.object({ invoiceId: id, invoiceNumber: id, totalMinor: minor, currency }).strict(),
  }),
  contract({
    type: "PaymentReceived", version: 1, aggregateType: "PAYMENT", scope: "ORGANIZATION",
    sensitivity: "LOW", producer: "billing payments (recordPayment)",
    payload: z.object({ paymentId: id, invoiceId: id, amountMinor: minor, currency }).strict(),
  }),
  contract({
    type: "PaymentFailed", version: 1, aggregateType: "PAYMENT", scope: "ORGANIZATION",
    sensitivity: "LOW", producer: "billing payments/webhooks",
    payload: z.object({ attemptId: id, invoiceId: optId, amountMinor: minor, currency, failureCode: optId }).strict(),
  }),
  contract({
    type: "RefundIssued", version: 1, aggregateType: "REFUND", scope: "ORGANIZATION",
    sensitivity: "LOW", producer: "billing refunds (refundPayment)",
    payload: z.object({ refundId: id, paymentId: id, amountMinor: minor, currency }).strict(),
  }),
  contract({
    type: "ReconciliationExceptionCreated", version: 1, aggregateType: "RECONCILIATION_EXCEPTION", scope: "ORGANIZATION",
    sensitivity: "LOW", producer: "commercial reconciliation / leakage detection",
    payload: z.object({ exceptionId: id, kind: id, severity: id, source: id }).strict(),
  }),
  contract({
    type: "ReconciliationExceptionResolved", version: 1, aggregateType: "RECONCILIATION_EXCEPTION", scope: "ORGANIZATION",
    sensitivity: "LOW", producer: "commercial reconciliation intelligence (transitionException)",
    payload: z.object({ exceptionId: id, status: id }).strict(),
  }),
];

const KEY = (type: string, version: number) => `${type}@${version}`;

const BY_KEY = new Map<string, EventContract>();
const CURRENT_VERSION = new Map<string, number>();
for (const c of EVENT_CONTRACTS) {
  const k = KEY(c.type, c.version);
  if (BY_KEY.has(k)) throw new Error(`Duplicate event contract ${k}`);
  BY_KEY.set(k, c);
  CURRENT_VERSION.set(c.type, Math.max(CURRENT_VERSION.get(c.type) ?? 0, c.version));
}

/** Every known event type name. */
export const ALL_EVENT_TYPES = [...CURRENT_VERSION.keys()].sort();

/** Latest declared version for a type, or undefined if the type is unknown. */
export function currentVersion(type: string): number | undefined {
  return CURRENT_VERSION.get(type);
}

/** Look up an exact (type, version) contract, or undefined if not in the catalogue. */
export function getEventContract(type: string, version: number): EventContract | undefined {
  return BY_KEY.get(KEY(type, version));
}
