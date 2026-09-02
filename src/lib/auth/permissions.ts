import type { Role } from "@prisma/client";

/**
 * Explicit permission strings, checked server-side on every route (see rbac.ts).
 * Navigation may also hide affordances a role can't use, but that is a UX
 * courtesy, never the authorization boundary — see
 * docs/STUDENT_PLATFORM_THREAT_MODEL.md T-02.
 */
export const PERMISSIONS = [
  "student:case:view",
  "student:case:attempt",
  "student:case:submit",
  "student:rx:simulate",
  "student:ai:tutor",
  "student:notes:create",
  "student:progress:view",
  "student:verification:submit",

  "educator:case:create",
  "educator:case:review",
  "educator:cohort:view",

  "institution:student:verify",
  "institution:cohort:manage",

  "admin:student:review",
  "admin:verification:manage",

  // Hospital OS (see docs/ENTERPRISE_HOSPITAL_ARCHITECTURE.md §4).
  // These are the real, server-checked implementations of the
  // OPERATIONAL_ONLY_ACTIONS placeholders declared below when Scholar was
  // built — STUDENT/PATIENT are never granted any of these.
  "hospital:command-center:view",
  "hospital:admin:manage",
  "patient:read",
  "patient:write",
  "encounter:create",
  "encounter:read",
  "encounter:triage",
  "vital:record",
  "clinical:note:create",
  "clinical:note:sign",
  "clinical:order:medication",
  "clinical:order:lab",
  "clinical:order:imaging",
  "medication:administer",
  "medication:verify",
  "lab:result:enter",
  "lab:result:release",
  "lab:result:acknowledge",
  "imaging:report:enter",
  "imaging:report:verify",
  "bed:manage",
  "admission:create",
  "admission:transfer",
  "admission:discharge:initiate",
  "admission:discharge:finalize",
  "billing:view",
  "billing:charge:create",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Roles explicitly EXCLUDED from any clinical-operational permission — a
 * STUDENT (or anyone else) must never reach these regardless of future
 * permission-table edits. Enforced again, redundantly, in rbac.ts.
 */
export const OPERATIONAL_ONLY_ACTIONS = [
  "patient:identity",
  "patient:write",
  "patient:prescribe",
  "doctor:sign",
  "clinical:order",
  "clinical:record:update",
] as const;

const ROLE_PERMISSIONS: Record<Role, ReadonlyArray<Permission>> = {
  PATIENT: [],
  DOCTOR: [
    "hospital:command-center:view",
    "patient:read",
    "patient:write",
    "encounter:create",
    "encounter:read",
    "encounter:triage",
    "vital:record",
    "clinical:note:create",
    "clinical:note:sign",
    "clinical:order:medication",
    "clinical:order:lab",
    "clinical:order:imaging",
    "admission:create",
    "admission:transfer",
    "admission:discharge:initiate",
    "admission:discharge:finalize",
    "lab:result:acknowledge",
    "imaging:report:verify",
    "billing:view",
  ],
  NURSE: [
    "hospital:command-center:view",
    "patient:read",
    "encounter:read",
    "vital:record",
    "clinical:note:create",
    "medication:administer",
    "bed:manage",
  ],
  LAB_TECHNICIAN: [
    "hospital:command-center:view",
    "patient:read",
    "encounter:read",
    "lab:result:enter",
    "lab:result:release",
  ],
  RADIOLOGY_TECH: [
    "hospital:command-center:view",
    "patient:read",
    "encounter:read",
    "imaging:report:enter",
  ],
  PHARMACIST: [
    "hospital:command-center:view",
    "patient:read",
    "encounter:read",
    "medication:verify",
  ],
  BILLING_STAFF: [
    "hospital:command-center:view",
    "patient:read",
    "encounter:read",
    "billing:view",
    "billing:charge:create",
  ],
  HOSPITAL_ADMIN: [
    "hospital:command-center:view",
    "hospital:admin:manage",
    "patient:read",
    "encounter:read",
    "bed:manage",
    "admission:create",
    "admission:transfer",
    "admission:discharge:initiate",
    "admission:discharge:finalize",
    "billing:view",
  ],
  STUDENT: [
    "student:case:view",
    "student:case:attempt",
    "student:case:submit",
    "student:rx:simulate",
    "student:ai:tutor",
    "student:notes:create",
    "student:progress:view",
    "student:verification:submit",
  ],
  EDUCATOR: [
    "student:case:view",
    "educator:case:create",
    "educator:case:review",
    "educator:cohort:view",
  ],
  INSTITUTION_ADMIN: [
    "student:case:view",
    "educator:cohort:view",
    "institution:student:verify",
    "institution:cohort:manage",
  ],
  AAROGYA_ADMIN: [
    "student:case:view",
    "educator:case:review",
    "admin:student:review",
    "admin:verification:manage",
    "hospital:command-center:view",
    "hospital:admin:manage",
    "patient:read",
    "encounter:read",
    "billing:view",
  ],
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
