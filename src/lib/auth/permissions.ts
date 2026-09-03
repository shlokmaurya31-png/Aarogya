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
  // Phase 4 Milestone E hardening — patient:read was being reused as the
  // read gate for the ENTIRE clinical chart (notes, diagnoses, medication
  // orders, lab/imaging results including critical values), which also
  // over-granted it to BILLING_STAFF/FRONT_DESK (who legitimately need
  // patient:read for demographics/check-in, but never held any other
  // clinical permission). clinical:chart:read is the narrower gate for
  // routes that expose actual clinical content; patient:read itself is
  // untouched everywhere else.
  "clinical:chart:read",
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

  // Phase 1 — Unified Clinical Core additions.
  "diagnosis:manage",
  "problem:manage",
  "allergy:manage",
  "episode:manage",
  "task:manage",
  "task:view",
  "document:manage",
  "consent:manage",
  "referral:create",
  "referral:respond",
  "patient:merge",
  "patient:duplicate:review",
  "patient:self:read",

  // Phase 2 — Patient Flow + Access + OPD + Emergency + ADT (brief §57).
  "patient:checkin",
  "appointment:create",
  "appointment:update",
  "appointment:cancel",
  "queue:manage",
  "triage:record",
  "encounter:assign",
  "admission:request",
  "admission:approve",
  "admission:allocate",
  "transfer:request",
  "transfer:approve",
  "transfer:execute",
  "discharge:approve",
  "bed:reserve",

  // Phase 3 — Doctor OS / Nursing OS / Medication Lifecycle / Pharmacy
  // (brief §33). Only genuinely new capabilities — verifying/dispensing a
  // medication, running a care plan, a structured handoff, a nursing
  // assignment, and I/O documentation have no existing permission that
  // already covers them. Ordering/administering/signing/vitals/tasks
  // reuse the existing clinical:order:medication / medication:administer /
  // clinical:note:* / vital:record / task:* permissions unchanged.
  // "medication:verify" already existed (Phase 0) granted to PHARMACIST but
  // had zero enforcement point until this phase's pharmacy workflow — see
  // below, not re-declared here.
  "carePlan:manage",
  "handoff:manage",
  "nursing:assignment:manage",
  "medication:dispense",
  "medication:discontinue",
  "io:record",

  // Phase 4 Milestone B — Laboratory core workflow (specimen lifecycle +
  // result verification/amendment). "lab:result:enter"/"acknowledge" and
  // "clinical:order:lab" already existed and are reused unchanged.
  "lab:specimen:collect",
  "lab:specimen:receive",
  "lab:specimen:accept",
  "lab:specimen:reject",
  "lab:result:verify",
  "lab:result:amend",
  "lab:catalog:manage",

  // Phase 4 Milestone C — Radiology core workflow (study scheduling/
  // execution + report verification/acknowledgement/amendment).
  // "imaging:report:enter" and "clinical:order:imaging" already existed
  // and are reused unchanged. "imaging:report:verify" already existed too
  // but had zero enforcement point until this milestone's verify route —
  // see below, not re-declared here.
  "radiology:schedule",
  "radiology:study:execute",
  "imaging:report:acknowledge",
  "imaging:report:amend",
  "radiology:catalog:manage",
  "radiology:resource:manage",
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
  PATIENT: ["patient:self:read"],
  DOCTOR: [
    "hospital:command-center:view",
    "patient:read",
    "clinical:chart:read",
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
    "imaging:report:acknowledge",
    "imaging:report:amend",
    "billing:view",
    "diagnosis:manage",
    "problem:manage",
    "allergy:manage",
    "episode:manage",
    "task:manage",
    "task:view",
    "document:manage",
    "consent:manage",
    "referral:create",
    "referral:respond",
    "patient:merge",
    "patient:duplicate:review",
    "patient:checkin",
    "appointment:update",
    "queue:manage",
    "triage:record",
    "encounter:assign",
    "admission:request",
    "transfer:request",
    "carePlan:manage",
    "handoff:manage",
    "medication:discontinue",
  ],
  NURSE: [
    "hospital:command-center:view",
    "patient:read",
    "clinical:chart:read",
    "encounter:read",
    "vital:record",
    "clinical:note:create",
    "medication:administer",
    "bed:manage",
    "allergy:manage",
    "task:manage",
    "task:view",
    "document:manage",
    "patient:checkin",
    "queue:manage",
    "triage:record",
    "transfer:request",
    "encounter:assign",
    "carePlan:manage",
    "handoff:manage",
    "nursing:assignment:manage",
    "io:record",
    "lab:specimen:collect",
  ],
  LAB_TECHNICIAN: [
    "hospital:command-center:view",
    "patient:read",
    "clinical:chart:read",
    "encounter:read",
    "lab:result:enter",
    "lab:result:release",
    "lab:specimen:collect",
    "lab:specimen:receive",
    "lab:specimen:accept",
    "lab:specimen:reject",
    "lab:result:verify",
    "lab:result:amend",
  ],
  RADIOLOGY_TECH: [
    "hospital:command-center:view",
    "patient:read",
    "clinical:chart:read",
    "encounter:read",
    "imaging:report:enter",
    "radiology:schedule",
    "radiology:study:execute",
  ],
  PHARMACIST: [
    "hospital:command-center:view",
    "patient:read",
    "clinical:chart:read",
    "encounter:read",
    "medication:verify",
    "medication:dispense",
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
    "clinical:chart:read",
    "encounter:read",
    "bed:manage",
    "admission:create",
    "admission:transfer",
    "admission:discharge:initiate",
    "admission:discharge:finalize",
    "billing:view",
    "task:view",
    "task:manage",
    "document:manage",
    "patient:merge",
    "patient:duplicate:review",
    "patient:checkin",
    "appointment:create",
    "appointment:update",
    "appointment:cancel",
    "queue:manage",
    "admission:approve",
    "admission:allocate",
    "transfer:approve",
    "transfer:execute",
    "discharge:approve",
    "bed:reserve",
    "nursing:assignment:manage",
    "lab:catalog:manage",
    "radiology:catalog:manage",
    "radiology:resource:manage",
  ],
  FRONT_DESK: [
    "hospital:command-center:view",
    "patient:read",
    "patient:write",
    "patient:checkin",
    "patient:duplicate:review",
    "encounter:create",
    "encounter:read",
    "appointment:create",
    "appointment:update",
    "appointment:cancel",
    "queue:manage",
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
    "clinical:chart:read",
    "encounter:read",
    "billing:view",
  ],
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
