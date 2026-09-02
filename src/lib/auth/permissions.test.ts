import { describe, it, expect } from "vitest";
import { roleHasPermission } from "./permissions";

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
