import { describe, it, expect } from "vitest";
import { evaluateCondition, assertConditionBounds, assertFieldPathSafe, type ConditionNode } from "./conditions";
import { validateWorkflowConfig } from "./validator";
import { classifyWorkflowError, isRetryable, WorkflowError, LIMITS } from "./types";
import { isInvokableFromDefinition, isKnownAction } from "./actions";

/**
 * Phase D7 — pure workflow-engine unit tests. DB-backed behaviour (event→workflow,
 * step execution, tasks/timers/SLA/escalation, retry, cancellation, recovery,
 * concurrency, security) is proven by scripts/verify-postgres-d7-workflows.ts on
 * both PostgreSQL and SQLite.
 */

const ctx = (payload: Record<string, unknown>, event: Partial<Record<string, unknown>> = {}) => ({
  event: { type: "LabResultReleased", version: 1, aggregateType: "LAB_RESULT", aggregateId: "r1", organizationId: "o1", facilityId: "f1", actor: "u1", ...event },
  payload,
});

describe("condition evaluation", () => {
  it("evaluates the core operator set correctly", () => {
    expect(evaluateCondition(ctx({ critical: true }), { field: "payload.critical", operator: "equals", value: true })).toBe(true);
    expect(evaluateCondition(ctx({ critical: false }), { field: "payload.critical", operator: "equals", value: true })).toBe(false);
    expect(evaluateCondition(ctx({ n: 5 }), { field: "payload.n", operator: "greater_than", value: 3 })).toBe(true);
    expect(evaluateCondition(ctx({ n: 5 }), { field: "payload.n", operator: "less_than_or_equal", value: 5 })).toBe(true);
    expect(evaluateCondition(ctx({ p: "STAT" }), { field: "payload.p", operator: "in", value: ["ROUTINE", "STAT"] })).toBe(true);
    expect(evaluateCondition(ctx({ p: "X" }), { field: "payload.p", operator: "not_in", value: ["ROUTINE", "STAT"] })).toBe(true);
    expect(evaluateCondition(ctx({ p: "abcdef" }), { field: "payload.p", operator: "contains", value: "cde" })).toBe(true);
    expect(evaluateCondition(ctx({ p: "x" }), { field: "payload.missing", operator: "not_exists" })).toBe(true);
    expect(evaluateCondition(ctx({}), { field: "event.type", operator: "equals", value: "LabResultReleased" })).toBe(true);
  });
  it("supports bounded all/any/not composition", () => {
    const node: ConditionNode = { all: [{ field: "payload.critical", operator: "equals", value: true }, { any: [{ field: "payload.n", operator: "greater_than", value: 10 }, { not: { field: "payload.flag", operator: "exists" } }] }] };
    expect(evaluateCondition(ctx({ critical: true, n: 11 }), node)).toBe(true);
    expect(evaluateCondition(ctx({ critical: true, n: 1 }), node)).toBe(true); // flag not present
    expect(evaluateCondition(ctx({ critical: true, n: 1, flag: 1 }), node)).toBe(false);
    expect(evaluateCondition(ctx({ critical: false, n: 20 }), node)).toBe(false);
  });
  it("never resolves outside the allow-listed roots or through prototype keys", () => {
    expect(() => assertFieldPathSafe("process.env.SECRET")).toThrow();
    expect(() => assertFieldPathSafe("payload.__proto__.x")).toThrow();
    expect(() => assertFieldPathSafe("payload.ok")).not.toThrow();
    // A resolver never reaches Object prototype pollution.
    expect(evaluateCondition(ctx({}), { field: "payload.__proto__", operator: "exists" })).toBe(false);
  });
  it("caps nesting and node count", () => {
    let deep: ConditionNode = { field: "payload.a", operator: "exists" };
    for (let i = 0; i < LIMITS.MAX_CONDITION_DEPTH + 2; i++) deep = { not: deep };
    expect(() => assertConditionBounds(deep)).toThrow();
  });
});

describe("definition validation", () => {
  const base = { trigger: { eventType: "LabResultReleased", eventVersion: 1 }, steps: [{ type: "TASK", key: "t", taskType: "X", title: "T" }] };
  it("accepts a valid definition", () => {
    expect(() => validateWorkflowConfig(base)).not.toThrow();
  });
  it("rejects an unknown trigger event / version", () => {
    expect(() => validateWorkflowConfig({ ...base, trigger: { eventType: "NopeEvent", eventVersion: 1 } })).toThrow();
    expect(() => validateWorkflowConfig({ ...base, trigger: { eventType: "LabResultReleased", eventVersion: 99 } })).toThrow();
  });
  it("rejects an unknown / non-invokable action", () => {
    expect(() => validateWorkflowConfig({ ...base, steps: [{ type: "ACTION", key: "a", action: { name: "DELETE_PATIENT", params: {} } }] })).toThrow();
    expect(() => validateWorkflowConfig({ ...base, steps: [{ type: "ACTION", key: "a", action: { name: "CREATE_TASK", params: {} } }] })).toThrow();
  });
  it("rejects EMIT_DOMAIN_EVENT targeting an unknown event", () => {
    expect(() => validateWorkflowConfig({ ...base, steps: [{ type: "ACTION", key: "a", action: { name: "EMIT_DOMAIN_EVENT", params: { eventType: "NopeEvent", payload: {} } } }] })).toThrow();
  });
  it("rejects an over-long pipeline and duplicate step keys", () => {
    const many = { ...base, steps: Array.from({ length: LIMITS.MAX_STEPS + 1 }, (_, i) => ({ type: "TIMER", key: `k${i}`, dueAfterSeconds: 60 })) };
    expect(() => validateWorkflowConfig(many)).toThrow();
    expect(() => validateWorkflowConfig({ ...base, steps: [{ type: "TIMER", key: "dup", dueAfterSeconds: 60 }, { type: "TIMER", key: "dup", dueAfterSeconds: 60 }] })).toThrow();
  });
  it("rejects an over-long timer duration", () => {
    expect(() => validateWorkflowConfig({ ...base, steps: [{ type: "TIMER", key: "t", dueAfterSeconds: LIMITS.MAX_TIMER_SECONDS + 1 }] })).toThrow();
  });
});

describe("action registry", () => {
  it("only exposes invokable actions to definitions", () => {
    expect(isKnownAction("EMIT_DOMAIN_EVENT")).toBe(true);
    expect(isInvokableFromDefinition("EMIT_DOMAIN_EVENT")).toBe(true);
    expect(isInvokableFromDefinition("CREATE_TASK")).toBe(false);
    expect(isInvokableFromDefinition("ARBITRARY")).toBe(false);
  });
});

describe("retry classification", () => {
  it("retries only transient categories", () => {
    expect(isRetryable(classifyWorkflowError(new WorkflowError("x", "TRANSIENT")).category)).toBe(true);
    expect(isRetryable(classifyWorkflowError(new WorkflowError("x", "TIMEOUT")).category)).toBe(true);
    expect(isRetryable(classifyWorkflowError({ status: 403 }).category)).toBe(false); // AUTHORIZATION
    expect(isRetryable(classifyWorkflowError({ status: 400 }).category)).toBe(false); // VALIDATION
    expect(isRetryable(classifyWorkflowError({ status: 404 }).category)).toBe(false); // NOT_FOUND
    expect(isRetryable(classifyWorkflowError({ status: 409 }).category)).toBe(true); // CONFLICT
  });
});
