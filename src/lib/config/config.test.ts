import { describe, it, expect } from "vitest";
import { resolveKeySpec, isKnownConfigKey, listRegistry } from "./registry";
import { ConfigError, assertJsonBounds, escalationSchema } from "./types";

/**
 * Phase D8 — pure configuration-engine unit tests (registry, typed parsing/
 * validation, bounds). DB-backed behaviour (scope inheritance, precedence,
 * provenance, effective dates, versioning/publication, reset, snapshot,
 * concurrency, security, multi-hospital resolution) is proven by
 * scripts/verify-postgres-d8-configuration.ts on PostgreSQL and SQLite.
 */

describe("registry", () => {
  it("recognizes exact keys and templated families, rejects arbitrary keys", () => {
    expect(isKnownConfigKey("sla.critical_result_ack")).toBe(true);
    expect(isKnownConfigKey("workflow.critical-lab-review.sla")).toBe(true);
    expect(isKnownConfigKey("workflow.critical-lab-review.enabled")).toBe(true);
    expect(isKnownConfigKey("alert.bed-shortage.severity")).toBe(true);
    expect(isKnownConfigKey("totally.unknown.key")).toBe(false);
    expect(isKnownConfigKey("workflow..sla")).toBe(false);
    expect(isKnownConfigKey("")).toBe(false);
  });
  it("lists registry metadata without exposing internals", () => {
    const r = listRegistry();
    expect(r.exact.length).toBeGreaterThan(0);
    expect(r.templates.length).toBeGreaterThan(0);
  });
});

describe("typed value parsing + normalization", () => {
  it("BOOLEAN", () => {
    const s = resolveKeySpec("workflow.x.enabled")!;
    expect(s.parse("true")).toBe(true);
    expect(s.normalize("TRUE")).toBe("true");
    expect(() => s.parse("yes")).toThrow(ConfigError);
  });
  it("DURATION accepts shorthand and normalizes to seconds", () => {
    const s = resolveKeySpec("sla.critical_result_ack")!;
    expect(s.parse("15m")).toBe(900);
    expect(s.normalize("15m")).toBe("900");
    expect(s.parse("4h")).toBe(14400);
    expect(s.normalize("30")).toBe("30");
    expect(() => s.parse("0")).toThrow();
    expect(() => s.parse("999d")).toThrow(); // exceeds max
    expect(() => s.parse("abc")).toThrow();
  });
  it("ENUM", () => {
    const s = resolveKeySpec("workflow.x.priority")!;
    expect(s.parse("STAT")).toBe("STAT");
    expect(() => s.parse("SUPER")).toThrow();
  });
  it("NUMBER with bounds", () => {
    const s = resolveKeySpec("billing.smallbalance.param")!;
    expect(s.parse("42")).toBe(42);
    expect(() => s.parse("-1")).toThrow();
  });
  it("JSON escalation is strictly validated; unknown keys + secrets + blobs rejected", () => {
    const s = resolveKeySpec("workflow.x.escalation")!;
    const good = JSON.stringify({ steps: [{ afterSeconds: 900, notifyRole: "DOCTOR", priority: "STAT" }] });
    expect(() => s.parse(good)).not.toThrow();
    expect(() => s.parse(JSON.stringify({ steps: [{ afterSeconds: 900, notifyRole: "DOCTOR", evil: 1 }] }))).toThrow(); // unknown key
    expect(() => s.parse(JSON.stringify({ steps: [{ afterSeconds: 900, notifyRole: "DOCTOR", apiKey: "x" }] }))).toThrow(); // sensitive/unknown
    expect(() => s.parse("not json")).toThrow();
  });
});

describe("safety bounds", () => {
  it("rejects over-deep JSON", () => {
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 8; i++) deep = { nested: deep };
    expect(() => assertJsonBounds(deep)).toThrow();
  });
  it("escalation schema caps step count", () => {
    const many = { steps: Array.from({ length: 11 }, () => ({ afterSeconds: 60, notifyRole: "R" })) };
    expect(escalationSchema.safeParse(many).success).toBe(false);
  });
});
