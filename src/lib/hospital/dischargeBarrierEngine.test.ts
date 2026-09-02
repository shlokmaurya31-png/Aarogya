import { describe, it, expect } from "vitest";
import { bucketDischarge, type DischargeBarrier } from "./dischargeBarrierEngine";

function barrier(code: string, blocked: boolean): DischargeBarrier {
  return { code, label: code, blocked, detail: "" };
}

describe("bucketDischarge — discharge work-queue bucketing (brief §40)", () => {
  it("buckets as READY_TO_LEAVE when nothing is blocked", () => {
    const barriers = [barrier("CLINICAL", false), barrier("BILLING", false)];
    expect(bucketDischarge(barriers)).toEqual({ bucket: "READY_TO_LEAVE", label: "Ready to leave" });
  });

  it("buckets under the FIRST blocking barrier, giving every patient one actionable next step", () => {
    const barriers = [barrier("CLINICAL", false), barrier("BILLING", true), barrier("INSURANCE", true)];
    const result = bucketDischarge(barriers);
    expect(result.bucket).toBe("BILLING");
    expect(result.label).toBe("Billing blocked");
  });

  it("maps pending-result barriers (lab/imaging/critical/consult) to a distinct label from readiness-flag barriers", () => {
    const result = bucketDischarge([barrier("PENDING_LAB", true)]);
    expect(result.label).toBe("Pending result");
  });

  it("a clinically-not-ready patient is never mistaken for merely administratively blocked", () => {
    const result = bucketDischarge([barrier("CLINICAL", true), barrier("BILLING", true)]);
    expect(result.bucket).toBe("CLINICAL");
    expect(result.label).toBe("Medically not ready");
  });
});
