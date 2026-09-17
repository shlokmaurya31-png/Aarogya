import { describe, it, expect } from "vitest";
import { ENTITLEMENTS, PLANS, DEFAULT_PLAN_CODE, isKnownEntitlement, getEntitlementSpec } from "./registry";
import { SUBSCRIPTION_TRANSITIONS, canTransitionSubscription, isCommercialActive } from "./constants";
import { deriveCommercialState } from "./evaluator";
import { roleHasPermission, PERMISSIONS, type Permission } from "@/lib/auth/permissions";
import type { Role, SubscriptionStatus } from "@prisma/client";

/**
 * Phase D2 — rules that hold regardless of data. Runtime behaviour against a
 * real database (isolation, escalation, limit races) is proven by
 * scripts/verify-postgres-commercial-entitlements.ts.
 */

describe("entitlement registry", () => {
  it("has unique keys, each fully specified", () => {
    const keys = new Set<string>();
    for (const e of ENTITLEMENTS) {
      expect(keys.has(e.key), `duplicate key ${e.key}`).toBe(false);
      keys.add(e.key);
      expect(["BOOLEAN", "LIMIT", "NUMBER"]).toContain(e.type);
      expect(["ORGANIZATION", "FACILITY"]).toContain(e.scope);
      if (e.type === "LIMIT") expect(e.defaultNumber !== undefined || e.defaultUnlimited === true).toBe(true);
      if (e.type === "BOOLEAN") expect(typeof e.defaultBool).toBe("boolean");
    }
  });

  it("refuses unknown keys (controlled registry)", () => {
    expect(isKnownEntitlement("hospital_os")).toBe(true);
    expect(isKnownEntitlement("made_up_feature")).toBe(false);
    expect(getEntitlementSpec("made_up_feature")).toBeUndefined();
  });
});

describe("plan catalogue", () => {
  it("only references known entitlement keys", () => {
    for (const p of PLANS) {
      for (const pe of p.entitlements) {
        expect(isKnownEntitlement(pe.key), `${p.code} references unknown ${pe.key}`).toBe(true);
      }
    }
  });

  it("has exactly one default (grandfather) plan, granting everything unlimited", () => {
    const defaults = PLANS.filter((p) => p.isDefault);
    expect(defaults.length).toBe(1);
    expect(defaults[0].code).toBe(DEFAULT_PLAN_CODE);
    const maxFac = defaults[0].entitlements.find((e) => e.key === "max_facilities");
    expect(maxFac?.unlimited).toBe(true);
  });

  it("starter is limited, enterprise is unlimited", () => {
    const starter = PLANS.find((p) => p.code === "starter")!;
    expect(starter.entitlements.find((e) => e.key === "max_facilities")?.number).toBe(1);
    expect(starter.entitlements.find((e) => e.key === "icu")?.bool).toBe(false);
    const ent = PLANS.find((p) => p.code === "enterprise")!;
    expect(ent.entitlements.find((e) => e.key === "max_facilities")?.unlimited).toBe(true);
  });
});

describe("subscription lifecycle", () => {
  it("declares transitions and refuses undeclared ones", () => {
    expect(canTransitionSubscription("TRIAL", "ACTIVE")).toBe(true);
    expect(canTransitionSubscription("ACTIVE", "SUSPENDED")).toBe(true);
    expect(canTransitionSubscription("SUSPENDED", "ACTIVE")).toBe(true);
    // Nonsensical:
    expect(canTransitionSubscription("EXPIRED", "TRIAL")).toBe(false);
    expect(canTransitionSubscription("ACTIVE", "TRIAL")).toBe(false);
    // Every declared target is a valid status.
    const valid = Object.keys(SUBSCRIPTION_TRANSITIONS);
    for (const tos of Object.values(SUBSCRIPTION_TRANSITIONS)) for (const t of tos) expect(valid).toContain(t);
  });

  it("classifies which states are commercially active", () => {
    const active: SubscriptionStatus[] = ["TRIAL", "ACTIVE", "PAST_DUE", "GRACE"];
    const inactive: SubscriptionStatus[] = ["SUSPENDED", "CANCELLED", "EXPIRED"];
    for (const s of active) expect(isCommercialActive(s)).toBe(true);
    for (const s of inactive) expect(isCommercialActive(s)).toBe(false);
  });
});

describe("deriveCommercialState (lazy expiry)", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  const future = new Date("2026-07-01T00:00:00Z");
  const past = new Date("2026-05-01T00:00:00Z");

  it("no subscription is inactive", () => {
    expect(deriveCommercialState(null, now)).toMatchObject({ status: "NONE", active: false });
  });
  it("active subscription is active", () => {
    expect(deriveCommercialState({ status: "ACTIVE", trialEndsAt: null, cancelAtPeriodEnd: false, currentPeriodEnd: future }, now).active).toBe(true);
  });
  it("a trial past its end is inactive even if the status column still says TRIAL", () => {
    const r = deriveCommercialState({ status: "TRIAL", trialEndsAt: past, cancelAtPeriodEnd: false, currentPeriodEnd: null }, now);
    expect(r.active).toBe(false);
    expect(r.reason).toBe("TRIAL_ENDED");
  });
  it("a not-yet-ended trial is active", () => {
    expect(deriveCommercialState({ status: "TRIAL", trialEndsAt: future, cancelAtPeriodEnd: false, currentPeriodEnd: null }, now).active).toBe(true);
  });
  it("cancel-at-period-end stays active until the period ends, then not", () => {
    expect(deriveCommercialState({ status: "ACTIVE", trialEndsAt: null, cancelAtPeriodEnd: true, currentPeriodEnd: future }, now).active).toBe(true);
    const ended = deriveCommercialState({ status: "ACTIVE", trialEndsAt: null, cancelAtPeriodEnd: true, currentPeriodEnd: past }, now);
    expect(ended.active).toBe(false);
    expect(ended.reason).toBe("PERIOD_ENDED");
  });
  it("suspended is inactive", () => {
    expect(deriveCommercialState({ status: "SUSPENDED", trialEndsAt: null, cancelAtPeriodEnd: false, currentPeriodEnd: null }, now).active).toBe(false);
  });
  it("a grace window still open keeps access", () => {
    expect(deriveCommercialState({ status: "GRACE", trialEndsAt: null, cancelAtPeriodEnd: false, currentPeriodEnd: null, gracePeriodEndsAt: future }, now).active).toBe(true);
  });
  it("a grace window past its end lapses even if the column still says GRACE", () => {
    const r = deriveCommercialState({ status: "GRACE", trialEndsAt: null, cancelAtPeriodEnd: false, currentPeriodEnd: null, gracePeriodEndsAt: past }, now);
    expect(r.active).toBe(false);
    expect(r.reason).toBe("GRACE_ENDED");
  });
});

describe("commercial permission grants — least privilege", () => {
  it("makes commercial mutation platform-only", () => {
    expect(roleHasPermission("AAROGYA_ADMIN", "commercial:platform:manage")).toBe(true);
    expect(roleHasPermission("HOSPITAL_ADMIN", "commercial:platform:manage")).toBe(false);
  });
  it("lets facility/org admins READ commercial state", () => {
    expect(roleHasPermission("HOSPITAL_ADMIN", "commercial:read")).toBe(true);
    expect(roleHasPermission("AAROGYA_ADMIN", "commercial:read")).toBe(true);
  });
  it("gives no clinical/other role any commercial permission", () => {
    const commercialPerms = PERMISSIONS.filter((p) => p.startsWith("commercial:")) as Permission[];
    const forbidden: Role[] = ["DOCTOR", "NURSE", "LAB_TECHNICIAN", "RADIOLOGY_TECH", "PHARMACIST", "BILLING_STAFF", "FRONT_DESK", "PROCUREMENT_OFFICER", "STUDENT", "PATIENT", "EDUCATOR", "INSTITUTION_ADMIN"];
    for (const role of forbidden) for (const p of commercialPerms) expect(roleHasPermission(role, p), `${role} must not hold ${p}`).toBe(false);
  });
});
