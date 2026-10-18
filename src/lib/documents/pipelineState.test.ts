import { describe, it, expect } from "vitest";
import { RUN_TRANSITIONS, STEP_TRANSITIONS, canRun, canStep, TERMINAL_RUN, PERMANENT_ERRORS } from "./pipelineState";
import { $Enums } from "@prisma/client";

describe("the pipeline state machine", () => {
  it("covers every run and step status of the schema", () => {
    expect(Object.keys(RUN_TRANSITIONS).sort()).toEqual(Object.values($Enums.DocumentProcessingStatus).sort());
    expect(Object.keys(STEP_TRANSITIONS).sort()).toEqual(Object.values($Enums.DocumentStepStatus).sort());
  });
  it("never leaves a terminal run state", () => {
    for (const t of TERMINAL_RUN) for (const to of Object.values($Enums.DocumentProcessingStatus)) expect(canRun(t, to)).toBe(false);
  });
  it("reaches review only through RUNNING, and completion only after it or from RUNNING", () => {
    expect(canRun("QUEUED", "AWAITING_REVIEW")).toBe(false);
    expect(canRun("RUNNING", "AWAITING_REVIEW")).toBe(true);
    expect(canRun("AWAITING_REVIEW", "COMPLETED")).toBe(true);
    expect(canRun("QUEUED", "SKIPPED")).toBe(true);
  });
  it("never leaves DONE, SKIPPED or FAILED; a running step may retry", () => {
    for (const t of ["DONE", "SKIPPED", "FAILED"] as const) for (const to of Object.values($Enums.DocumentStepStatus)) expect(canStep(t, to)).toBe(false);
    expect(canStep("RUNNING", "RUNNING")).toBe(true);
    expect(canStep("PENDING", "DONE")).toBe(false);
  });
  it("treats the closed permanent errors as final", () => {
    expect([...PERMANENT_ERRORS].sort()).toEqual(["EXACT_COPY_VIOLATION", "TOO_LARGE", "UNREADABLE", "UNSUPPORTED_LANGUAGE"]);
  });
});
