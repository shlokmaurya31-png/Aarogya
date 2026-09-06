import { describe, it, expect } from "vitest";
import { isInvoiceTransitionAllowed } from "./invoices";

describe("isInvoiceTransitionAllowed — invoice state machine", () => {
  it("allows DRAFT -> ISSUED", () => {
    expect(isInvoiceTransitionAllowed("DRAFT", "ISSUED")).toBe(true);
  });

  it("allows DRAFT -> VOID (a draft can be discarded outright)", () => {
    expect(isInvoiceTransitionAllowed("DRAFT", "VOID")).toBe(true);
  });

  it("rejects DRAFT -> PAID (cannot skip issuance)", () => {
    expect(isInvoiceTransitionAllowed("DRAFT", "PAID")).toBe(false);
  });

  it("allows ISSUED -> PARTIALLY_PAID", () => {
    expect(isInvoiceTransitionAllowed("ISSUED", "PARTIALLY_PAID")).toBe(true);
  });

  it("allows ISSUED -> PAID directly (a single full payment)", () => {
    expect(isInvoiceTransitionAllowed("ISSUED", "PAID")).toBe(true);
  });

  it("allows PARTIALLY_PAID -> PAID", () => {
    expect(isInvoiceTransitionAllowed("PARTIALLY_PAID", "PAID")).toBe(true);
  });

  it("rejects PAID -> DRAFT (illegal reverse transition — the exact adversarial case from the brief)", () => {
    expect(isInvoiceTransitionAllowed("PAID", "DRAFT")).toBe(false);
  });

  it("rejects any transition out of a terminal PAID state", () => {
    expect(isInvoiceTransitionAllowed("PAID", "VOID")).toBe(false);
  });

  it("rejects any transition out of a terminal VOID state", () => {
    expect(isInvoiceTransitionAllowed("VOID", "ISSUED")).toBe(false);
  });
});
