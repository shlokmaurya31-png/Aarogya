import type { KnowledgeAccessClass, Role } from "@prisma/client";

/**
 * RAG Phase 3, step 3.4 — which knowledge documents a role may read through
 * knowledge Q&A (docs/RAG_ARCHITECTURE.md §4.2: "its access class against the
 * caller's role"). Every class is the organisation's documents for the
 * caller's facility or the whole organisation, in force now; this table only
 * narrows by class. Conservative where a reading was open: a hospital
 * administrator manages every document but reads only ALL_STAFF, BILLING and
 * ADMIN ones here; PHARMACY (the formulary) is for prescribers, pharmacists
 * and the approvers. Pending review with the hospital's quality team.
 */
export const KNOWLEDGE_CLASSES_BY_ROLE: Partial<Record<Role, readonly KnowledgeAccessClass[]>> = {
  DOCTOR: ["ALL_STAFF", "CLINICAL", "PHARMACY"],
  NURSE: ["ALL_STAFF", "CLINICAL"],
  PHARMACIST: ["ALL_STAFF", "CLINICAL", "PHARMACY"],
  LAB_TECHNICIAN: ["ALL_STAFF", "CLINICAL"],
  RADIOLOGY_TECH: ["ALL_STAFF", "CLINICAL"],
  BILLING_STAFF: ["ALL_STAFF", "BILLING"],
  FRONT_DESK: ["ALL_STAFF", "BILLING"],
  PROCUREMENT_OFFICER: ["ALL_STAFF"],
  HOSPITAL_ADMIN: ["ALL_STAFF", "BILLING", "ADMIN"],
  MEDICAL_SUPERINTENDENT: ["ALL_STAFF", "CLINICAL", "PHARMACY", "ADMIN"],
  QUALITY_LEAD: ["ALL_STAFF", "CLINICAL", "PHARMACY", "ADMIN"],
};

export function knowledgeClassesFor(role: Role): KnowledgeAccessClass[] {
  return [...(KNOWLEDGE_CLASSES_BY_ROLE[role] ?? [])];
}
