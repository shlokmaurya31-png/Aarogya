import { describe, it, expect } from "vitest";
import { parseBuilderDocument } from "./document";
import { compileBuilderDocument, buildValidationReport, diffConfigs, BuilderIncompleteError } from "./compile";
import { simulateWorkflow } from "./simulate";
import { WORKFLOW_TEMPLATES, listTemplates } from "./templates";
import { builderMetadata } from "./metadata";

/**
 * Phase D9 — pure workflow-builder unit tests (document parsing/bounds, compile to
 * canonical D7 config, validation report, diff, templates, metadata, side-effect-free
 * simulation without config DB access). DB-backed behaviour (drafts, publish → D7
 * execution, multi-hospital SLA, concurrency, security) is proven by
 * scripts/verify-postgres-d9-builder.ts.
 */

describe("builder document", () => {
  it("accepts an incomplete draft (no trigger/steps) but rejects secrets/PHI blobs", () => {
    expect(() => parseBuilderDocument({ name: "draft" })).not.toThrow();
    // secret key at any depth is rejected
    expect(() => parseBuilderDocument({ name: "x", steps: [{ type: "TASK", key: "t", title: "T", password: "secret" }] })).toThrow();
    // blob-length value (looks like a clinical narrative) is rejected
    expect(() => parseBuilderDocument({ name: "x", steps: [{ type: "TASK", key: "t", title: "y".repeat(600) }] })).toThrow();
    // unknown top-level keys are stripped (not persisted), not an error
    const stripped = parseBuilderDocument({ name: "ok", bogus: 123 });
    expect((stripped as Record<string, unknown>).bogus).toBeUndefined();
  });
});

describe("compile → canonical D7 config", () => {
  const good = { name: "w", trigger: { eventType: "LabResultReleased", eventVersion: 1, condition: { all: [{ field: "payload.critical", operator: "equals", value: true }] } }, steps: [{ type: "TASK", key: "review", taskType: "REVIEW", title: "Review", priority: "STAT" }] };
  it("compiles a valid document", () => {
    const cfg = compileBuilderDocument(parseBuilderDocument(good));
    expect(cfg.trigger.eventType).toBe("LabResultReleased");
    expect(cfg.steps).toHaveLength(1);
  });
  it("rejects an incomplete draft on compile", () => {
    expect(() => compileBuilderDocument(parseBuilderDocument({ name: "w" }))).toThrow(BuilderIncompleteError);
    expect(() => compileBuilderDocument(parseBuilderDocument({ name: "w", trigger: { eventType: "LabResultReleased", eventVersion: 1 } }))).toThrow(BuilderIncompleteError);
  });
  it("delegates to the D7 validator (unknown event / action rejected)", () => {
    expect(() => compileBuilderDocument(parseBuilderDocument({ name: "w", trigger: { eventType: "NopeEvent", eventVersion: 1 }, steps: [{ type: "TASK", key: "t", taskType: "T", title: "T" }] }))).toThrow();
    expect(() => compileBuilderDocument(parseBuilderDocument({ name: "w", trigger: { eventType: "LabResultReleased", eventVersion: 1 }, steps: [{ type: "ACTION", key: "a", action: { name: "DROP_DB", params: {} } }] }))).toThrow();
  });
});

describe("validation report", () => {
  it("reports valid + sections for a good doc, invalid + errors for a bad one", () => {
    const ok = buildValidationReport(parseBuilderDocument({ name: "w", trigger: { eventType: "AdmissionCreated", eventVersion: 1 }, steps: [{ type: "TASK", key: "t", taskType: "T", title: "T" }] }));
    expect(ok.valid).toBe(true);
    expect(ok.sections.length).toBeGreaterThan(0);
    const bad = buildValidationReport(parseBuilderDocument({ name: "w" }));
    expect(bad.valid).toBe(false);
    expect(bad.errors.length).toBeGreaterThan(0);
  });
});

describe("diff", () => {
  it("detects added/removed/changed steps and trigger change", () => {
    const a = compileBuilderDocument(parseBuilderDocument({ name: "a", trigger: { eventType: "AdmissionCreated", eventVersion: 1 }, steps: [{ type: "TASK", key: "x", taskType: "X", title: "X" }] }));
    const b = compileBuilderDocument(parseBuilderDocument({ name: "b", trigger: { eventType: "AdmissionCreated", eventVersion: 1 }, steps: [{ type: "TASK", key: "y", taskType: "Y", title: "Y" }] }));
    const d = diffConfigs(a, b);
    expect(d.addedSteps).toContain("TASK:y");
    expect(d.removedSteps).toContain("TASK:x");
    expect(d.triggerChanged).toBe(false);
  });
});

describe("templates + metadata", () => {
  it("every template compiles to a valid canonical config", () => {
    for (const t of WORKFLOW_TEMPLATES) {
      expect(() => compileBuilderDocument(parseBuilderDocument(t.document))).not.toThrow();
    }
    expect(listTemplates().length).toBe(WORKFLOW_TEMPLATES.length);
  });
  it("metadata is sourced from the canonical registries", () => {
    const m = builderMetadata();
    expect(m.triggers.some((t) => t.eventType === "AdmissionCreated")).toBe(true);
    expect(m.actions).toContain("EMIT_DOMAIN_EVENT");
    expect(m.actions).not.toContain("CREATE_TASK"); // not invokable from a definition
    expect(m.operators).toContain("equals");
  });
});

describe("simulation (side-effect-free, no config DB access without a key)", () => {
  it("matches trigger + conditions and reports would-run steps", async () => {
    const cfg = compileBuilderDocument(parseBuilderDocument({ name: "w", trigger: { eventType: "LabResultReleased", eventVersion: 1, condition: { all: [{ field: "payload.critical", operator: "equals", value: true }] } }, steps: [{ type: "TASK", key: "review", taskType: "REVIEW", title: "Review", priority: "STAT", sla: { dueAfterSeconds: 900, escalation: { taskType: "E", title: "e" } } }] }));
    const matched = await simulateWorkflow({ config: cfg, synthetic: { payload: { critical: true } } });
    expect(matched.triggerMatched).toBe(true);
    expect(matched.steps[0].outcome).toBe("WOULD_EXECUTE");
    expect(matched.steps[0].slaSeconds).toBe(900);
    const notMatched = await simulateWorkflow({ config: cfg, synthetic: { payload: { critical: false } } });
    expect(notMatched.triggerMatched).toBe(false);
  });
});
