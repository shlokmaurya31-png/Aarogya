/**
 * Phase D11 — patient-facing language boundary (brief §33, §59).
 *
 * Canonical database enums are internal vocabulary. The patient never sees
 * "IN_CONSULTATION" or "PARTIALLY_PAID"; they see "In consultation" and
 * "Partially paid". These maps translate at the presentation boundary ONLY —
 * no canonical enum is renamed. An unknown value falls back to a humanized
 * form of the raw string rather than throwing, so a new backend status never
 * crashes the portal.
 */

function humanize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

const APPOINTMENT_STATUS: Record<string, string> = {
  REQUESTED: "Requested",
  CONFIRMED: "Confirmed",
  RESCHEDULED: "Rescheduled",
  ARRIVED: "Arrived",
  CHECKED_IN: "Checked in",
  WAITING: "Waiting",
  IN_CONSULTATION: "In consultation",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  NO_SHOW: "Missed",
};

const APPOINTMENT_TYPE: Record<string, string> = {
  NEW: "New visit",
  FOLLOW_UP: "Follow-up",
  PROCEDURE: "Procedure",
  REVIEW: "Review",
  TELEMEDICINE: "Video consultation",
  EMERGENCY_OVERRIDE: "Emergency",
};

const QUEUE_STATUS: Record<string, string> = {
  WAITING: "Waiting",
  CALLED: "Called in",
  IN_SERVICE: "Being seen",
  COMPLETED: "Done",
  SKIPPED: "Skipped",
  CANCELLED: "Cancelled",
};

const INVOICE_STATUS: Record<string, string> = {
  DRAFT: "Being prepared",
  ISSUED: "Due",
  PARTIALLY_PAID: "Partially paid",
  PAID: "Paid",
  VOID: "Cancelled",
};

const ENCOUNTER_STATUS: Record<string, string> = {
  REGISTERED: "Registered",
  TRIAGE: "In triage",
  IN_PROGRESS: "Visit in progress",
  ADMITTED: "Admitted",
  DISCHARGED: "Discharged",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

const COVERAGE_STATUS: Record<string, string> = {
  ACTIVE: "Active",
  INACTIVE: "Inactive",
  EXPIRED: "Expired",
  SUSPENDED: "Suspended",
};

const PREAUTH_STATUS: Record<string, string> = {
  DRAFT: "Being prepared",
  REQUESTED: "Approval requested",
  PENDING: "Approval pending",
  APPROVED: "Approved",
  PARTIALLY_APPROVED: "Partially approved",
  DENIED: "Not approved",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
};

const CLAIM_STATUS: Record<string, string> = {
  DRAFT: "Being prepared",
  SUBMITTED: "Submitted to insurer",
  QUERIED: "Insurer needs more information",
  APPROVED: "Approved",
  PARTIALLY_APPROVED: "Partially approved",
  DENIED: "Not approved",
  SETTLED: "Settled",
  CANCELLED: "Cancelled",
};

const MEDICATION_STATUS: Record<string, string> = {
  DRAFT: "Draft",
  ORDERED: "Prescribed",
  VERIFIED: "Prescribed",
  DISPENSED: "Dispensed",
  ADMINISTERED: "Given",
  COMPLETED: "Completed",
  DISCONTINUED: "Stopped",
  CANCELLED: "Cancelled",
  HELD: "On hold",
  PHARMACY_REVIEW: "With pharmacy",
};

const CONSENT_STATUS: Record<string, string> = {
  REQUESTED: "Requested",
  GRANTED: "Granted",
  ACTIVE: "Active",
  EXPIRED: "Expired",
  REVOKED: "Revoked",
  DECLINED: "Declined",
  CANCELLED: "Cancelled",
};

const pick = (map: Record<string, string>, v: string | null | undefined): string =>
  v == null ? "Unknown" : map[v] ?? humanize(v);

export const patientLanguage = {
  appointmentStatus: (v?: string | null) => pick(APPOINTMENT_STATUS, v),
  appointmentType: (v?: string | null) => pick(APPOINTMENT_TYPE, v),
  queueStatus: (v?: string | null) => pick(QUEUE_STATUS, v),
  invoiceStatus: (v?: string | null) => pick(INVOICE_STATUS, v),
  encounterStatus: (v?: string | null) => pick(ENCOUNTER_STATUS, v),
  coverageStatus: (v?: string | null) => pick(COVERAGE_STATUS, v),
  preAuthStatus: (v?: string | null) => pick(PREAUTH_STATUS, v),
  claimStatus: (v?: string | null) => pick(CLAIM_STATUS, v),
  medicationStatus: (v?: string | null) => pick(MEDICATION_STATUS, v),
  consentStatus: (v?: string | null) => pick(CONSENT_STATUS, v),
  humanize,
};
