import { describe, it, expect } from "vitest";
import { resolveLoginDestination } from "./roleDestination";

describe("resolveLoginDestination — post-login role routing", () => {
  it("sends PATIENT to the patient portal", () => {
    expect(resolveLoginDestination("PATIENT")).toBe("/patient");
  });

  it("sends STUDENT to Scholar student app", () => {
    expect(resolveLoginDestination("STUDENT")).toBe("/student");
  });

  it("sends EDUCATOR to Scholar educator app", () => {
    expect(resolveLoginDestination("EDUCATOR")).toBe("/educator");
  });

  it("sends every Hospital OS staff role to /hospital-os", () => {
    const hospitalRoles = [
      "DOCTOR",
      "NURSE",
      "LAB_TECHNICIAN",
      "RADIOLOGY_TECH",
      "PHARMACIST",
      "BILLING_STAFF",
      "FRONT_DESK",
      "HOSPITAL_ADMIN",
    ] as const;
    for (const role of hospitalRoles) {
      expect(resolveLoginDestination(role)).toBe("/hospital-os");
    }
  });

  it("sends AAROGYA_ADMIN to the cross-product app picker, not directly into either app", () => {
    expect(resolveLoginDestination("AAROGYA_ADMIN")).toBe("/select-app");
  });

  it("falls back to home for a role with no built destination (INSTITUTION_ADMIN) rather than erroring", () => {
    expect(resolveLoginDestination("INSTITUTION_ADMIN")).toBe("/");
  });
});
