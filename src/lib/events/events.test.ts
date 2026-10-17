import { describe, it, expect } from "vitest";
import { emitDomainEvent } from "./emit";
import { getEventContract, currentVersion, ALL_EVENT_TYPES, EVENT_CONTRACTS } from "./catalogue";
import { assertNoSensitiveData } from "./sensitiveGuard";
import { classifyEventError, PermanentEventError, RetryableEventError, isDataIntegrityCode, DATA_ERROR_ATTEMPTS } from "./types";
import { $Enums } from "@prisma/client";

/**
 * Phase D6 — event CONTRACT tests (pure). DB-backed behaviour (transactional
 * outbox atomicity, dispatch, idempotency, retry, dead-letter, poison isolation,
 * concurrency, immutability under processing) is proven by
 * scripts/verify-postgres-d6-events.ts against both PostgreSQL and SQLite.
 *
 * emit() validates the event fully BEFORE touching the DB, so these tests use a
 * capturing stub client to assert both rejections and the persisted envelope
 * without a database.
 */

function capture() {
  const rows: Record<string, unknown>[] = [];
  const client = { domainEventOutbox: { create: async ({ data }: { data: Record<string, unknown> }) => { rows.push(data); return data; } } } as unknown as Parameters<typeof emitDomainEvent>[0];
  return { client, rows };
}

describe("catalogue", () => {
  it("declares each type at a resolvable current version with a strict payload schema", () => {
    expect(ALL_EVENT_TYPES.length).toBeGreaterThan(0);
    for (const c of EVENT_CONTRACTS) {
      expect(getEventContract(c.type, c.version)).toBeTruthy();
      expect(currentVersion(c.type)).toBeGreaterThanOrEqual(c.version);
    }
  });
  it("returns undefined for unknown type or version (incompatible version rejection)", () => {
    expect(currentVersion("NopeEvent")).toBeUndefined();
    expect(getEventContract("PatientRegistered", 999)).toBeUndefined();
    expect(getEventContract("PatientRegistered", 1)).toBeTruthy();
  });
});

describe("emit validation", () => {
  it("rejects an unknown event type permanently", async () => {
    const { client } = capture();
    await expect(emitDomainEvent(client, { type: "NopeEvent", aggregateId: "a", payload: {} }))
      .rejects.toMatchObject({ code: "UNKNOWN_TYPE" });
  });
  it("rejects an unknown version permanently", async () => {
    const { client } = capture();
    await expect(emitDomainEvent(client, { type: "PatientRegistered", version: 999, aggregateId: "a", organizationId: "o", facilityId: "f", payload: { patientId: "p" } }))
      .rejects.toMatchObject({ code: "UNKNOWN_VERSION" });
  });
  it("rejects a payload that violates the schema", async () => {
    const { client } = capture();
    await expect(emitDomainEvent(client, { type: "PaymentReceived", aggregateId: "a", organizationId: "o", payload: { paymentId: "p", invoiceId: "i", amountMinor: "not-a-number", currency: "INR" } }))
      .rejects.toMatchObject({ code: "SCHEMA_INVALID" });
  });
  it("rejects unknown extra payload keys (strict schema)", async () => {
    const { client } = capture();
    await expect(emitDomainEvent(client, { type: "PatientRegistered", aggregateId: "a", organizationId: "o", facilityId: "f", payload: { patientId: "p", extra: "leak" } }))
      .rejects.toMatchObject({ code: "SCHEMA_INVALID" });
  });
  it("rejects an organization/facility-scoped event with no tenant", async () => {
    const { client } = capture();
    await expect(emitDomainEvent(client, { type: "PaymentReceived", aggregateId: "a", payload: { paymentId: "p", invoiceId: "i", amountMinor: 100, currency: "INR" } }))
      .rejects.toMatchObject({ code: "MISSING_TENANT" });
  });
  it("rejects a facility-scoped event with no facility", async () => {
    const { client } = capture();
    await expect(emitDomainEvent(client, { type: "PatientRegistered", aggregateId: "a", organizationId: "o", payload: { patientId: "p" } }))
      .rejects.toMatchObject({ code: "MISSING_FACILITY" });
  });
});

describe("emit envelope", () => {
  it("persists tenant, correlation and causation and defaults correlation to the event id", async () => {
    const { client, rows } = capture();
    const r = await emitDomainEvent(client, { type: "PaymentReceived", aggregateId: "pay1", organizationId: "org1", actorUserId: "u1", causationId: "cause1", payload: { paymentId: "pay1", invoiceId: "inv1", amountMinor: 4999, currency: "INR" } });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.organizationId).toBe("org1");
    expect(row.actorUserId).toBe("u1");
    expect(row.causationId).toBe("cause1");
    expect(row.eventType).toBe("PaymentReceived");
    expect(row.eventVersion).toBe(1);
    expect(row.status).toBe("PENDING");
    expect(row.correlationId).toBe(r.eventId); // defaulted to eventId
    expect(row.eventId).toBe(r.eventId);
  });
  it("honours an explicit correlationId to chain a causal operation", async () => {
    const { client, rows } = capture();
    await emitDomainEvent(client, { type: "InvoiceCreated", aggregateId: "inv1", organizationId: "org1", correlationId: "corr-XYZ", payload: { invoiceId: "inv1", totalMinor: 1000, currency: "INR" } });
    expect(rows[0].correlationId).toBe("corr-XYZ");
  });
});

describe("sensitive-data guard", () => {
  it("rejects forbidden keys at any depth", () => {
    expect(() => assertNoSensitiveData({ ok: 1, nested: { password: "x" } })).toThrow();
    expect(() => assertNoSensitiveData({ cardNumber: "4111" })).toThrow();
    expect(() => assertNoSensitiveData({ webhookSecret: "s" })).toThrow();
    expect(() => assertNoSensitiveData({ patientId: "p", invoiceId: "i", amountMinor: 100 })).not.toThrow();
  });
  it("rejects blob-length strings that look like notes, not identifiers", () => {
    expect(() => assertNoSensitiveData({ note: "x".repeat(600) })).toThrow();
    expect(() => assertNoSensitiveData({ patientId: "x".repeat(600) })).toThrow();
  });
  it("accepts every key every catalogued contract declares (a contract the guard refuses can never be emitted)", () => {
    /** A skeleton of the schema's keys at every depth, leaves "x". */
    const skeleton = (schema: unknown): unknown => {
      const s = schema as { shape?: Record<string, unknown>; unwrap?: () => unknown; element?: unknown };
      if (s.shape) return Object.fromEntries(Object.entries(s.shape).map(([k, v]) => [k, skeleton(v)]));
      if (s.element) return [skeleton(s.element)];
      if (typeof s.unwrap === "function") return skeleton(s.unwrap());
      return "x";
    };
    for (const c of EVENT_CONTRACTS) {
      expect(() => assertNoSensitiveData(skeleton(c.payload)), `${c.type} v${c.version}`).not.toThrow();
    }
  });
});

describe("error classification", () => {
  it("treats explicit markers, 4xx and unknowns correctly", () => {
    expect(classifyEventError(new PermanentEventError("no", "X")).retryable).toBe(false);
    expect(classifyEventError(new RetryableEventError("later", "Y")).retryable).toBe(true);
    expect(classifyEventError({ status: 403 }).retryable).toBe(false);
    expect(classifyEventError(new Error("boom")).retryable).toBe(true);
  });
  it("gives data-integrity errors (missing parent, row gone) a short, bounded budget", () => {
    for (const code of ["P2003", "P2014", "P2018", "P2025"]) {
      const c = classifyEventError(Object.assign(new Error("fk"), { code }));
      expect(c.code).toBe(`DATA_${code}`);
      expect(isDataIntegrityCode(c.code)).toBe(true);
    }
    expect(isDataIntegrityCode(classifyEventError(Object.assign(new Error("dup"), { code: "P2002" })).code)).toBe(false);
    expect(DATA_ERROR_ATTEMPTS).toBeLessThan(8);
  });
});

describe("payload codes mirror the Prisma enums they describe", () => {
  // A contract's closed set must not drift from the column it reports: a new
  // database value would otherwise be rejected at emit (and roll the write back).
  const field = (type: string, key: string) => {
    const shape = (getEventContract(type, 1)!.payload as unknown as { shape: Record<string, { unwrap?: () => unknown; options?: string[] }> }).shape;
    let f = shape[key] as { options?: string[]; unwrap?: () => unknown };
    while (!f.options && f.unwrap) f = f.unwrap() as typeof f;
    return [...(f.options ?? [])].sort();
  };
  const values = (e: Record<string, string>) => Object.values(e).sort();
  it.each([
    ["MedicationOrderStatusChanged", "to", $Enums.MedicationOrderStatus],
    ["ExternalLabReferralStatusChanged", "to", $Enums.ExternalLabStatus],
    ["StockLotStatusChanged", "to", $Enums.LotStatus],
    ["IcuDeviceStatusChanged", "to", $Enums.IcuDeviceStatus],
    ["IcuInfusionStatusChanged", "to", $Enums.IcuInfusionStatus],
    ["LabOrderPlaced", "priority", $Enums.Priority],
    ["SpecimenStatusChanged", "rejectionReason", $Enums.SpecimenRejectionReason],
    ["MedicationReconciliationRecorded", "source", $Enums.ReconciliationSource],
    ["MedicationReconciliationRecorded", "decision", $Enums.ReconciliationDecision],
    ["MedicationSafetyWarningOverridden", "severity", $Enums.SafetySeverity],
    ["CarePlanUpdated", "status", $Enums.CarePlanStatus],
    ["ClinicalHandoffStatusChanged", "handoffType", $Enums.HandoffType],
    ["ClinicalHandoffStatusChanged", "urgency", $Enums.RequestPriority],
  ] as const)("%s.%s", (type, key, prismaEnum) => {
    expect(field(type, key)).toEqual(values(prismaEnum as Record<string, string>));
  });
});

describe("step-7 payload codes mirror their sources", () => {
  const options = (type: string, key: string) => {
    const shape = (getEventContract(type, 1)!.payload as unknown as { shape: Record<string, { options?: string[]; unwrap?: () => unknown; element?: unknown }> }).shape;
    let f = shape[key] as { options?: string[]; unwrap?: () => unknown; element?: unknown };
    while (!f.options && (f.unwrap || f.element)) f = (f.element ?? f.unwrap!()) as typeof f;
    return [...(f.options ?? [])].sort();
  };
  it("DocumentGenerated.documentType = DOCUMENT_TYPES", async () => {
    const { DOCUMENT_TYPES } = await import("@/lib/documents/templates");
    expect(options("DocumentGenerated", "documentType")).toEqual([...DOCUMENT_TYPES].sort());
  });
  it("PatientDocumentUploaded.documentType = PATIENT_DOCUMENT_TYPES", async () => {
    const { PATIENT_DOCUMENT_TYPES } = await import("@/lib/patient/experience/documents");
    expect(options("PatientDocumentUploaded", "documentType")).toEqual([...PATIENT_DOCUMENT_TYPES].sort());
  });
  it("FamilyAccessGranted.scopes = DELEGATION_SCOPES", async () => {
    const { DELEGATION_SCOPES } = await import("@/lib/patient/context");
    expect(options("FamilyAccessGranted", "scopes")).toEqual([...DELEGATION_SCOPES].sort());
  });
  it("PatientAccessSessionStatusChanged.to = PatientAccessSessionStatus", () => {
    expect(options("PatientAccessSessionStatusChanged", "to")).toEqual(Object.values($Enums.PatientAccessSessionStatus).sort());
  });
});

describe("step-9 payload codes mirror their sources", () => {
  const options = (type: string, key: string) => {
    const shape = (getEventContract(type, 1)!.payload as unknown as { shape: Record<string, { options?: string[]; unwrap?: () => unknown }> }).shape;
    let f = shape[key] as { options?: string[]; unwrap?: () => unknown };
    while (!f.options && f.unwrap) f = f.unwrap() as typeof f;
    return [...(f.options ?? [])].sort();
  };
  const cases: [string, string, readonly string[]][] = [
    ["HospitalInvoiceVoided", "from", Object.values($Enums.InvoiceStatus)],
    ["HospitalInvoiceIssued", "documentType", Object.values($Enums.InvoiceDocumentType)],
    ["HospitalPaymentRecorded", "method", Object.values($Enums.PaymentMethod)],
    ["HospitalPaymentStatusChanged", "status", Object.values($Enums.PaymentStatus)],
    ["HospitalRefundStatusChanged", "to", Object.values($Enums.RefundStatus)],
    ["BillingAdjustmentStatusChanged", "to", Object.values($Enums.AdjustmentStatus)],
    ["BillingAdjustmentStatusChanged", "adjustmentType", Object.values($Enums.AdjustmentType)],
    ["CoverageStatusChanged", "to", Object.values($Enums.CoverageStatus)],
    ["PreauthStatusChanged", "to", Object.values($Enums.PreAuthStatus)],
    ["ClaimStatusChanged", "to", Object.values($Enums.ClaimStatus)],
    ["ClaimQueryStatusChanged", "to", Object.values($Enums.ClaimQueryStatus)],
    ["ClaimReconciliationStatusChanged", "to", Object.values($Enums.ReconciliationExceptionStatus)],
    ["ClaimReconciliationStatusChanged", "severity", Object.values($Enums.AlertSeverity)],
    ["CreditStatusChanged", "status", Object.values($Enums.BillingCreditStatus)],
    ["CreditStatusChanged", "creditType", Object.values($Enums.BillingCreditType)],
    ["InvoiceVoided", "from", Object.values($Enums.BillingInvoiceStatus)],
    ["SubscriptionStatusChanged", "to", Object.values($Enums.SubscriptionStatus)],
  ];
  for (const [type, key, source] of cases) {
    it(`${type}.${key} mirrors its Prisma enum`, () => expect(options(type, key)).toEqual([...source].sort()));
  }
  it("ChargePosted.category = CHARGE_CATEGORIES", async () => {
    const { CHARGE_CATEGORIES } = await import("@/lib/hospital/billing/chargeCapture");
    expect(options("ChargePosted", "category")).toEqual([...CHARGE_CATEGORIES].sort());
  });
  it("ClaimReconciliationStatusChanged.exceptionType = EXCEPTION_TYPES", async () => {
    const { EXCEPTION_TYPES } = await import("@/lib/hospital/nhcx/stateMachines");
    expect(options("ClaimReconciliationStatusChanged", "exceptionType")).toEqual([...EXCEPTION_TYPES].sort());
  });
});

describe("batch 6 payload codes mirror their sources", () => {
  const options = (type: string, key: string) => {
    const shape = (getEventContract(type, 1)!.payload as unknown as { shape: Record<string, { options?: string[]; unwrap?: () => unknown }> }).shape;
    let f = shape[key] as { options?: string[]; unwrap?: () => unknown };
    while (!f.options && f.unwrap) f = f.unwrap() as typeof f;
    return [...(f.options ?? [])].sort();
  };
  it("ClinicalDocumentRecorded.documentType = CLINICAL_DOCUMENT_TYPE_CODES", async () => {
    const { CLINICAL_DOCUMENT_TYPE_CODES } = await import("@/lib/documents/staffDocuments");
    expect(options("ClinicalDocumentRecorded", "documentType")).toEqual([...CLINICAL_DOCUMENT_TYPE_CODES].sort());
  });
  it("ClinicalDocumentRecorded.accessPolicy = ClinicalDocumentAccessPolicy", () => {
    expect(options("ClinicalDocumentRecorded", "accessPolicy")).toEqual(Object.values($Enums.ClinicalDocumentAccessPolicy).sort());
  });
  it("DischargeHoldChanged.reasonCode = DischargeHoldReason", () => {
    expect(options("DischargeHoldChanged", "reasonCode")).toEqual(Object.values($Enums.DischargeHoldReason).sort());
  });
});

describe("step-9a payload codes mirror their sources", () => {
  const options = (type: string, key: string) => {
    const shape = (getEventContract(type, 1)!.payload as unknown as { shape: Record<string, { options?: string[]; unwrap?: () => unknown }> }).shape;
    let f = shape[key] as { options?: string[]; unwrap?: () => unknown };
    while (!f.options && f.unwrap) f = f.unwrap() as typeof f;
    return [...(f.options ?? [])].sort();
  };
  it("StockMoved codes mirror StockMovementType, UnitOfMeasure, WasteReason and AdjustmentReason", () => {
    expect(options("StockMoved", "movementType")).toEqual(Object.values($Enums.StockMovementType).sort());
    expect(options("StockMoved", "unit")).toEqual(Object.values($Enums.UnitOfMeasure).sort());
    expect(options("StockMoved", "wasteReason")).toEqual(Object.values($Enums.WasteReason).sort());
    expect(options("StockMoved", "adjustmentReason")).toEqual(Object.values($Enums.AdjustmentReason).sort());
  });
  it("PurchaseOrderStatusChanged and SupplierInvoiceStatusChanged statuses mirror their enums", () => {
    expect(options("PurchaseOrderStatusChanged", "to")).toEqual(Object.values($Enums.PurchaseOrderStatus).sort());
    expect(options("SupplierInvoiceStatusChanged", "to")).toEqual(Object.values($Enums.SupplierInvoiceStatus).sort());
  });
  it("StockDocumentStatusChanged statuses are exactly the union of the four documents' status enums", () => {
    const union = [...new Set([...Object.values($Enums.StockAdjustmentStatus), ...Object.values($Enums.WasteRecordStatus), ...Object.values($Enums.GoodsReceiptStatus), ...Object.values($Enums.StockTakeStatus)])].sort();
    expect(options("StockDocumentStatusChanged", "from")).toEqual(union);
    expect(options("StockDocumentStatusChanged", "to")).toEqual(union);
  });
});
