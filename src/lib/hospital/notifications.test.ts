import { describe, it, expect } from "vitest";
import {
  coerceCategory,
  coercePriority,
  clampLimit,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_PRIORITIES,
} from "./notifications";

/**
 * Phase E1 — pure rules of the Notification Center that hold regardless of
 * data. Runtime DB behaviour (recipient ownership scoping, mark-read
 * idempotency, cross-tenant/cross-recipient isolation) is proven against a
 * real database by scripts/verify-postgres-e1-notifications.ts.
 */

describe("notification category coercion", () => {
  it("passes through every known category", () => {
    for (const c of NOTIFICATION_CATEGORIES) expect(coerceCategory(c)).toBe(c);
  });
  it("defaults unknown/empty to OPERATIONAL (never throws)", () => {
    expect(coerceCategory("MADE_UP")).toBe("OPERATIONAL");
    expect(coerceCategory(undefined)).toBe("OPERATIONAL");
    expect(coerceCategory(null)).toBe("OPERATIONAL");
    expect(coerceCategory(42)).toBe("OPERATIONAL");
  });
});

describe("notification priority coercion", () => {
  it("passes through every known priority", () => {
    for (const p of NOTIFICATION_PRIORITIES) expect(coercePriority(p)).toBe(p);
  });
  it("defaults unknown/empty to ROUTINE (never throws)", () => {
    expect(coercePriority("SUPER_URGENT")).toBe("ROUTINE");
    expect(coercePriority(undefined)).toBe("ROUTINE");
    expect(coercePriority(null)).toBe("ROUTINE");
  });
});

describe("list-limit clamping", () => {
  it("keeps sane values", () => {
    expect(clampLimit(10)).toBe(10);
    expect(clampLimit(1)).toBe(1);
    expect(clampLimit(100)).toBe(100);
  });
  it("clamps to the 1..100 window and rejects junk", () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-5)).toBe(1);
    expect(clampLimit(9999)).toBe(100);
    expect(clampLimit("abc")).toBe(30); // fallback
    expect(clampLimit(undefined)).toBe(30);
    expect(clampLimit(12.9)).toBe(12); // truncated
  });
});
