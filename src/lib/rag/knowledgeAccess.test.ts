import { describe, expect, it } from "vitest";
import type { Role } from "@prisma/client";
import { knowledgeClassesFor, KNOWLEDGE_CLASSES_BY_ROLE } from "./knowledgeAccess";
import { roleHasPermission } from "@/lib/auth/permissions";

/** RAG Phase 3, step 3.4: access classes by role; only staff with ai:knowledge:ask read any. */
describe("knowledge access classes", () => {
  it("every role with classes holds ai:knowledge:ask, and every class list includes ALL_STAFF", () => {
    for (const [role, classes] of Object.entries(KNOWLEDGE_CLASSES_BY_ROLE)) {
      expect(roleHasPermission(role as Role, "ai:knowledge:ask")).toBe(true);
      expect(classes).toContain("ALL_STAFF");
    }
  });
  it("patients, Scholar and platform roles read no knowledge", () => {
    for (const r of ["PATIENT", "STUDENT", "EDUCATOR", "INSTITUTION_ADMIN", "AAROGYA_ADMIN", "CLINICAL_ADVISOR", "SAFETY_OFFICER"] as Role[]) {
      expect(knowledgeClassesFor(r)).toEqual([]);
      expect(roleHasPermission(r, "ai:knowledge:ask")).toBe(false);
    }
  });
  it("clinical documents for clinical roles only; billing for billing; the formulary for prescribers and pharmacy", () => {
    expect(knowledgeClassesFor("NURSE")).toContain("CLINICAL");
    expect(knowledgeClassesFor("BILLING_STAFF")).not.toContain("CLINICAL");
    expect(knowledgeClassesFor("HOSPITAL_ADMIN")).not.toContain("CLINICAL");
    expect(knowledgeClassesFor("DOCTOR")).not.toContain("BILLING");
    expect(knowledgeClassesFor("PHARMACIST")).toContain("PHARMACY");
    expect(knowledgeClassesFor("NURSE")).not.toContain("PHARMACY");
  });
});
