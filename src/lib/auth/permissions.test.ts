import { describe, it, expect } from "vitest";
import { roleHasPermission, type Permission } from "./permissions";

describe("roleHasPermission — RBAC boundary", () => {
  it("STUDENT can attempt and submit cases", () => {
    expect(roleHasPermission("STUDENT", "student:case:attempt")).toBe(true);
    expect(roleHasPermission("STUDENT", "student:case:submit")).toBe(true);
  });

  it("STUDENT cannot review verifications or manage them", () => {
    expect(roleHasPermission("STUDENT", "admin:verification:manage")).toBe(false);
    expect(roleHasPermission("STUDENT", "admin:student:review")).toBe(false);
  });

  it("STUDENT cannot create or review educator cases", () => {
    expect(roleHasPermission("STUDENT", "educator:case:create")).toBe(false);
    expect(roleHasPermission("STUDENT", "educator:case:review")).toBe(false);
  });

  it("PATIENT and DOCTOR roles hold no Scholar permissions", () => {
    expect(roleHasPermission("PATIENT", "student:case:view")).toBe(false);
    expect(roleHasPermission("DOCTOR", "student:case:view")).toBe(false);
  });

  it("EDUCATOR can create and review cases but cannot manage verifications", () => {
    expect(roleHasPermission("EDUCATOR", "educator:case:create")).toBe(true);
    expect(roleHasPermission("EDUCATOR", "admin:verification:manage")).toBe(false);
  });

  it("AAROGYA_ADMIN can manage verifications but cannot attempt student cases", () => {
    expect(roleHasPermission("AAROGYA_ADMIN", "admin:verification:manage")).toBe(true);
    expect(roleHasPermission("AAROGYA_ADMIN", "student:case:attempt")).toBe(false);
  });

  it("INSTITUTION_ADMIN can verify students but not author cases", () => {
    expect(roleHasPermission("INSTITUTION_ADMIN", "institution:student:verify")).toBe(true);
    expect(roleHasPermission("INSTITUTION_ADMIN", "educator:case:create")).toBe(false);
  });
});

describe("roleHasPermission — Hospital OS boundary", () => {
  it("DOCTOR can order medications, labs and imaging, and sign notes", () => {
    expect(roleHasPermission("DOCTOR", "clinical:order:medication")).toBe(true);
    expect(roleHasPermission("DOCTOR", "clinical:order:lab")).toBe(true);
    expect(roleHasPermission("DOCTOR", "clinical:order:imaging")).toBe(true);
    expect(roleHasPermission("DOCTOR", "clinical:note:sign")).toBe(true);
  });

  it("NURSE can administer medications and record vitals but cannot order them", () => {
    expect(roleHasPermission("NURSE", "medication:administer")).toBe(true);
    expect(roleHasPermission("NURSE", "vital:record")).toBe(true);
    expect(roleHasPermission("NURSE", "clinical:order:medication")).toBe(false);
  });

  it("LAB_TECHNICIAN can release results but cannot place clinical orders or view billing", () => {
    expect(roleHasPermission("LAB_TECHNICIAN", "lab:result:release")).toBe(true);
    expect(roleHasPermission("LAB_TECHNICIAN", "clinical:order:lab")).toBe(false);
    expect(roleHasPermission("LAB_TECHNICIAN", "billing:view")).toBe(false);
  });

  it("BILLING_STAFF can view and create charges but cannot place clinical orders or administer medication", () => {
    expect(roleHasPermission("BILLING_STAFF", "billing:view")).toBe(true);
    expect(roleHasPermission("BILLING_STAFF", "billing:charge:create")).toBe(true);
    expect(roleHasPermission("BILLING_STAFF", "clinical:order:medication")).toBe(false);
    expect(roleHasPermission("BILLING_STAFF", "medication:administer")).toBe(false);
  });

  it("HOSPITAL_ADMIN can finalize discharge and manage beds but cannot place clinical orders", () => {
    expect(roleHasPermission("HOSPITAL_ADMIN", "admission:discharge:finalize")).toBe(true);
    expect(roleHasPermission("HOSPITAL_ADMIN", "bed:manage")).toBe(true);
    expect(roleHasPermission("HOSPITAL_ADMIN", "clinical:order:medication")).toBe(false);
  });

  it("STUDENT and PATIENT hold none of the operational hospital permissions — the placeholder boundary from Scholar is now real", () => {
    const operational: Permission[] = [
      "patient:write", "clinical:order:medication", "clinical:note:sign",
      "admission:create", "bed:manage", "billing:charge:create",
    ];
    for (const p of operational) {
      expect(roleHasPermission("STUDENT", p)).toBe(false);
      expect(roleHasPermission("PATIENT", p)).toBe(false);
    }
  });

  it("RADIOLOGY_TECH and PHARMACIST are scoped to their own domain only", () => {
    expect(roleHasPermission("RADIOLOGY_TECH", "imaging:report:enter")).toBe(true);
    expect(roleHasPermission("RADIOLOGY_TECH", "lab:result:enter")).toBe(false);
    expect(roleHasPermission("PHARMACIST", "medication:verify")).toBe(true);
    expect(roleHasPermission("PHARMACIST", "medication:administer")).toBe(false);
  });

  it("only HOSPITAL_ADMIN can manage the MedicationItemLink write path (inventory:item:manage) — PHARMACIST and NURSE cannot", () => {
    expect(roleHasPermission("HOSPITAL_ADMIN", "inventory:item:manage")).toBe(true);
    expect(roleHasPermission("PHARMACIST", "inventory:item:manage")).toBe(false);
    expect(roleHasPermission("NURSE", "inventory:item:manage")).toBe(false);
  });
});

describe("roleHasPermission — Phase 6.7 Nursing Core boundary", () => {
  it("NURSE can create and sign nursing assessments", () => {
    expect(roleHasPermission("NURSE", "nursing:assessment:create")).toBe(true);
    expect(roleHasPermission("NURSE", "nursing:assessment:sign")).toBe(true);
  });

  it("NURSE can now sign clinical notes via the (previously unwired) clinical:note:sign permission", () => {
    expect(roleHasPermission("NURSE", "clinical:note:sign")).toBe(true);
    expect(roleHasPermission("DOCTOR", "clinical:note:sign")).toBe(true);
  });

  it("FRONT_DESK, BILLING_STAFF, and PHARMACIST hold none of the Phase 6.7 nursing mutation permissions", () => {
    const nursingOnly: Permission[] = [
      "nursing:assessment:create",
      "nursing:assessment:sign",
      "nursing:assignment:manage",
      "handoff:manage",
      "carePlan:manage",
      "io:record",
      "task:manage",
    ];
    for (const p of nursingOnly) {
      expect(roleHasPermission("FRONT_DESK", p)).toBe(false);
      expect(roleHasPermission("BILLING_STAFF", p)).toBe(false);
      expect(roleHasPermission("PHARMACIST", p)).toBe(false);
    }
  });
});

describe("roleHasPermission — Phase B1 ICU boundary", () => {
  it("DOCTOR and NURSE can record ICU flowsheet observations, devices and infusions", () => {
    for (const role of ["DOCTOR", "NURSE"] as const) {
      expect(roleHasPermission(role, "icu:flowsheet:record")).toBe(true);
      expect(roleHasPermission(role, "icu:device:manage")).toBe(true);
      expect(roleHasPermission(role, "icu:infusion:manage")).toBe(true);
    }
  });

  it("ICU unit configuration is restricted to HOSPITAL_ADMIN (not DOCTOR/NURSE)", () => {
    expect(roleHasPermission("HOSPITAL_ADMIN", "icu:unit:manage")).toBe(true);
    expect(roleHasPermission("DOCTOR", "icu:unit:manage")).toBe(false);
    expect(roleHasPermission("NURSE", "icu:unit:manage")).toBe(false);
  });

  it("non-clinical roles hold no ICU recording or config permissions", () => {
    const icuPerms: Permission[] = ["icu:unit:manage", "icu:flowsheet:record", "icu:device:manage", "icu:infusion:manage"];
    for (const p of icuPerms) {
      expect(roleHasPermission("FRONT_DESK", p)).toBe(false);
      expect(roleHasPermission("BILLING_STAFF", p)).toBe(false);
      expect(roleHasPermission("PHARMACIST", p)).toBe(false);
    }
  });
});
