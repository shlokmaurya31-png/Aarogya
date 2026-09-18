import { describe, it, expect } from "vitest";
import { emitDomainEvent } from "./emit";
import { getEventContract, currentVersion, ALL_EVENT_TYPES, EVENT_CONTRACTS } from "./catalogue";
import { assertNoSensitiveData } from "./sensitiveGuard";
import { classifyEventError, PermanentEventError, RetryableEventError } from "./types";

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
  const rows: any[] = [];
  const client = { domainEventOutbox: { create: async ({ data }: any) => { rows.push(data); return data; } } } as any;
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
    await expect(emitDomainEvent(client, { type: "PaymentReceived", aggregateId: "a", organizationId: "o", payload: { paymentId: "p", invoiceId: "i", amountMinor: "not-a-number", currency: "INR" } as any }))
      .rejects.toMatchObject({ code: "SCHEMA_INVALID" });
  });
  it("rejects unknown extra payload keys (strict schema)", async () => {
    const { client } = capture();
    await expect(emitDomainEvent(client, { type: "PatientRegistered", aggregateId: "a", organizationId: "o", facilityId: "f", payload: { patientId: "p", extra: "leak" } as any }))
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
});

describe("error classification", () => {
  it("treats explicit markers, 4xx and unknowns correctly", () => {
    expect(classifyEventError(new PermanentEventError("no", "X")).retryable).toBe(false);
    expect(classifyEventError(new RetryableEventError("later", "Y")).retryable).toBe(true);
    expect(classifyEventError({ status: 403 }).retryable).toBe(false);
    expect(classifyEventError(new Error("boom")).retryable).toBe(true);
  });
});
