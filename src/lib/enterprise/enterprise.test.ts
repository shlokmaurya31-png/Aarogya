import { describe, it, expect } from "vitest";
import {
  ORGANIZATION_TRANSITIONS,
  FACILITY_TRANSITIONS,
  findOrganizationTransition,
  findFacilityTransition,
  CONFIG_KEYS,
  isKnownConfigKey,
} from "./constants";
import { PERMISSIONS, roleHasPermission, type Permission } from "@/lib/auth/permissions";
import type { Role } from "@prisma/client";

/**
 * Phase D1 — rules that must hold regardless of data. The runtime behaviour
 * against a real database (isolation, escalation, concurrency) is proven by
 * scripts/verify-postgres-enterprise-tenancy.ts; these pin the invariants.
 */

describe("lifecycle transition matrices", () => {
  it("allows exactly the intended organization transitions", () => {
    expect(findOrganizationTransition("ACTIVE", "SUSPENDED")).toBeTruthy();
    expect(findOrganizationTransition("SUSPENDED", "ACTIVE")).toBeTruthy();
    expect(findOrganizationTransition("ACTIVE", "DEACTIVATED")).toBeTruthy();
    expect(findOrganizationTransition("SUSPENDED", "DEACTIVATED")).toBeTruthy();
  });

  it("refuses nonsensical or self organization transitions", () => {
    expect(findOrganizationTransition("ACTIVE", "ACTIVE")).toBeNull();
    expect(findOrganizationTransition("DEACTIVATED", "SUSPENDED")).toBeNull();
  });

  it("marks reactivating a DEACTIVATED tenant as platform-only", () => {
    expect(findOrganizationTransition("DEACTIVATED", "ACTIVE")?.platformOnly).toBe(true);
    expect(findFacilityTransition("DEACTIVATED", "ACTIVE")?.platformOnly).toBe(true);
  });

  it("makes a new facility require explicit activation (PROVISIONING -> ACTIVE)", () => {
    expect(findFacilityTransition("PROVISIONING", "ACTIVE")).toBeTruthy();
    // Nothing transitions INTO provisioning.
    expect(FACILITY_TRANSITIONS.some((t) => t.to === "PROVISIONING")).toBe(false);
    expect(ORGANIZATION_TRANSITIONS.every((t) => t.from !== t.to)).toBe(true);
  });
});

describe("configuration registry", () => {
  it("gives every known key a non-empty default and description", () => {
    for (const [key, meta] of Object.entries(CONFIG_KEYS)) {
      expect(isKnownConfigKey(key)).toBe(true);
      expect(typeof meta.default).toBe("string");
      expect(meta.description.length).toBeGreaterThan(5);
    }
  });

  it("refuses unknown keys (closed registry, not a generic settings bag)", () => {
    expect(isKnownConfigKey("arbitrary.injected.key")).toBe(false);
  });
});

describe("enterprise permission grants — least privilege", () => {
  const ENTERPRISE_PERMS = PERMISSIONS.filter((p) => p.startsWith("enterprise:")) as Permission[];

  it("declares the enterprise permission set", () => {
    expect(ENTERPRISE_PERMS).toContain("enterprise:platform:manage");
    expect(ENTERPRISE_PERMS).toContain("enterprise:organization:manage");
    expect(ENTERPRISE_PERMS).toContain("enterprise:facility:manage");
  });

  it("gives creating/deactivating tenants (platform:manage) to the platform admin only", () => {
    expect(roleHasPermission("AAROGYA_ADMIN", "enterprise:platform:manage")).toBe(true);
    // A facility/organization admin (HOSPITAL_ADMIN) must NOT be able to create
    // or deactivate organizations or provision tenants.
    expect(roleHasPermission("HOSPITAL_ADMIN", "enterprise:platform:manage")).toBe(false);
  });

  it("gives the coarse org/facility management gate to HOSPITAL_ADMIN and AAROGYA_ADMIN", () => {
    for (const perm of ["enterprise:organization:manage", "enterprise:facility:manage", "enterprise:membership:manage", "enterprise:config:manage"] as Permission[]) {
      expect(roleHasPermission("HOSPITAL_ADMIN", perm)).toBe(true);
      expect(roleHasPermission("AAROGYA_ADMIN", perm)).toBe(true);
    }
  });

  it("gives NO clinical or non-admin role any enterprise permission", () => {
    const forbiddenRoles: Role[] = ["DOCTOR", "NURSE", "LAB_TECHNICIAN", "RADIOLOGY_TECH", "PHARMACIST", "BILLING_STAFF", "FRONT_DESK", "PROCUREMENT_OFFICER", "STUDENT", "PATIENT", "EDUCATOR", "INSTITUTION_ADMIN"];
    for (const role of forbiddenRoles) {
      for (const perm of ENTERPRISE_PERMS) {
        expect(roleHasPermission(role, perm), `${role} must not hold ${perm}`).toBe(false);
      }
    }
  });
});
