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

  // Phase 5 — Billing + Insurance + Revenue Cycle. "billing:view" and
  // "billing:charge:create" already existed (Phase 0/4) and are reused
  // unchanged. Maker/checker split across the two existing roles rather
  // than a new "Finance" Role enum value — see docs/PHASE_5_BILLING_ARCHITECTURE.md.
  "billing:charge:void",
  "billing:tariff:manage",
  "billing:package:manage",
  "billing:invoice:create",
  "billing:invoice:issue",
  "billing:invoice:void",
  "billing:payment:record",
  "billing:payment:void",
  "billing:refund:request",
  "billing:refund:approve",
  "billing:adjustment:create",
  "billing:adjustment:approve",
  "billing:reconciliation:view",
  "insurance:coverage:manage",
  "insurance:preauth:manage",
  "insurance:claim:create",
  "insurance:claim:submit",
  "insurance:claim:review",

  // Phase 6A — Inventory + Procurement Foundation.
  "inventory:item:view",
  "inventory:item:manage",
  "inventory:location:manage",
  "inventory:stock:view",
  "inventory:stock:receive",
  "inventory:stock:issue",
  "inventory:stock:reserve",
  "inventory:stock:transfer",
  "inventory:stock:adjust",
  "inventory:stock:waste",
  "inventory:lot:quarantine",
  "inventory:stocktake:manage",
  "inventory:report:view",
  "procurement:supplier:view",
  "procurement:supplier:manage",
  "procurement:requisition:create",
  "procurement:requisition:approve",
  "procurement:po:view",
  "procurement:po:create",
  "procurement:po:approve",
  "procurement:po:cancel",
  "procurement:goodsReceipt:create",
  "procurement:goodsReceipt:approve",

  // Phase 6.7 — Nursing Core (see docs/PHASE_6_7_NURSING.md). The
  // NursingAssessment lifecycle has no existing permission that covers it;
  // flowsheet/vitals/I-O/handoff/tasks/care-plan reuse clinical:chart:read/
  // vital:record/io:record/handoff:manage/task:*/carePlan:manage unchanged.
  "nursing:assessment:create",
  "nursing:assessment:sign",

  // Phase B1 — ICU Foundation. Unit configuration is an admin action;
  // admission/transfer reuse the existing admission:* permissions;
  // flowsheet observations / devices / infusions are clinical recording
  // actions for DOCTOR/NURSE.
  "icu:unit:manage",
  "icu:flowsheet:record",
  "icu:device:manage",
  "icu:infusion:manage",

  // Phase B3 — Operating Theatre & Surgical Workflow. Theatre/procedure-
  // catalog config is an admin action; surgical clinical actions are
  // DOCTOR/NURSE per least privilege (see role grants below).
  "ot:theatre:manage",
  "ot:procedure:create",
  "ot:procedure:review",
  "ot:procedure:schedule",
  "ot:procedure:manage",
  "ot:checklist:record",
  "ot:anesthesia:record",
  "ot:procedure:document",
  "ot:implant:record",
  "ot:specimen:record",
  "ot:recovery:manage",

  // Phase B4 — Blood Bank & Transfusion Management. Config (products/units/
  // inventory disposition) is HOSPITAL_ADMIN; blood typing/crossmatch is the
  // LAB_TECHNICIAN's authorized lab workflow; request/clinical review is
  // DOCTOR; bedside verification/transfusion/observation/reaction reporting is
  // NURSE. See role grants below for the least-privilege split.
  "blood:configuration:manage",
  "blood:unit:manage",
  "blood:inventory:manage",
  "blood:typing:record",
  "blood:compatibility:record",
  "blood:compatibility:verify",
  "blood:request:create",
  "blood:request:review",
  "blood:reservation:manage",
  "blood:issue",
  "blood:transport:manage",
  "blood:transfusion:record",
  "blood:reaction:record",
  "blood:reaction:manage",

  // Phase B5 — Emergency Department. Arrival/registration is an operational
  // action (FRONT_DESK/NURSE/DOCTOR/ADMIN); reassessment/resuscitation/location
  // are ED clinical-operational (DOCTOR/NURSE); disposition is a clinician
  // decision (DOCTOR/ADMIN only — never NURSE/LAB/RADIOLOGY/FRONT_DESK/BILLING/
  // PHARMACIST); recording a death is further restricted (ed:disposition:death).
  // Triage reuses the existing triage:record; ED clinical notes reuse
  // clinical:note:create/sign; orders/meds/labs/imaging/blood reuse their
  // existing permissions unchanged.
  "ed:encounter:create",
  "ed:reassessment:record",
  "ed:resuscitation:manage",
  "ed:location:manage",
  "ed:disposition:manage",
  "ed:disposition:death",

  // Phase B6 — Enterprise Pharmacy & Medication Supply Chain. Verification/
  // hold/reject reuse the existing medication:verify; ordering reuses
  // clinical:order:medication; administration reuses medication:administer.
  // These are the genuinely-new pharmacy-operational capabilities. Master/
  // formulary/recall are HOSPITAL_ADMIN configuration; dispense/return/
  // quarantine/controlled/transfer/trace are the PHARMACIST's operational
  // scope; request:create is available to the clinical roles that raise ward
  // requests; substitution:authorize is an explicit clinician/pharmacist action.
  "pharmacy:master:manage",
  "pharmacy:formulary:manage",
  "pharmacy:dispense",
  "pharmacy:return",
  "pharmacy:quarantine",
  "pharmacy:recall",
  "pharmacy:controlled:manage",
  "pharmacy:request:create",
  "pharmacy:request:fulfill",
  "pharmacy:transfer",
  "pharmacy:trace:view",
  "pharmacy:command:view",
  "pharmacy:storage:record",
  "pharmacy:substitution:authorize",

  // Phase B7 — Advanced Diagnostics. The full specimen/result/study/report
  // lifecycle reuses the existing lab:* / imaging:* / radiology:* permissions
  // unchanged (collect/receive/accept/reject/result:enter/verify/release/amend/
  // acknowledge, report:enter/verify/amend/acknowledge, schedule/study:execute).
  // These three are the genuinely-new LIS quality-management capabilities. PACS
  // acquisition reuses radiology:study:execute; barcode lookup + specimen
  // identity reuse lab:specimen:collect. `lab:result:release` remains the
  // authorized-reviewer (pathologist) gate — no new production role invented.
  "lab:qc:manage",
  "lab:calibration:manage",
  "lab:external:manage",

  // Phase B8 — Enterprise Inventory + Procurement Depth. Existing Phase 6A
  // inventory/procurement permissions (inventory:stock:*, inventory:lot:*,
  // procurement:requisition/po/goodsReceipt:*) are reused unchanged. These are
  // the genuinely-new enterprise capabilities: RFQ/contract/invoice procurement
  // depth (PROCUREMENT_OFFICER + HOSPITAL_ADMIN), sensitive supplier data
  // (GST/PAN/bank), inventory valuation, and generic department supply requests.
  "procurement:rfq:manage",
  "procurement:contract:manage",
  "procurement:invoice:manage",
  "procurement:supplier:sensitive:view",
  "inventory:valuation:view",
  "inventory:request:create",
  "inventory:request:fulfill",
  "inventory:serial:manage",
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
    // Phase 6A — narrow view-only, per the brief's explicit instruction.
    "inventory:item:view",
    // Phase B8 — clinicians may raise a department supply request (consume-side only).
    "inventory:request:create",
    // Phase B1 — ICU clinical recording.
    "icu:flowsheet:record",
    "icu:device:manage",
    "icu:infusion:manage",
    // Phase B3 — surgeon-side surgical workflow.
    "ot:procedure:create",
    "ot:procedure:review",
    "ot:procedure:schedule",
    "ot:procedure:manage",
    "ot:checklist:record",
    "ot:anesthesia:record",
    "ot:procedure:document",
    "ot:implant:record",
    "ot:specimen:record",
    "ot:recovery:manage",
    // Phase B4 — request blood, clinical review/authorization (incl. emergency
    // release), bedside transfusion oversight, reaction reporting + management.
    "blood:request:create",
    "blood:request:review",
    "blood:transfusion:record",
    "blood:reaction:record",
    "blood:reaction:manage",
    // Phase B5 — full ED clinical workflow incl. disposition and death.
    "ed:encounter:create",
    "ed:reassessment:record",
    "ed:resuscitation:manage",
    "ed:location:manage",
    "ed:disposition:manage",
    "ed:disposition:death",
    // Phase B6 — clinician pharmacy touchpoints: raise ward requests, authorize
    // an explicit substitution, and view medication traceability. NO pharmacy
    // master/formulary/dispense/verify administration.
    "pharmacy:request:create",
    "pharmacy:substitution:authorize",
    "pharmacy:trace:view",
  ],
  NURSE: [
    "hospital:command-center:view",
    "patient:read",
    "clinical:chart:read",
    "encounter:read",
    "vital:record",
    "clinical:note:create",
    "clinical:note:sign",
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
    "nursing:assessment:create",
    "nursing:assessment:sign",
    "io:record",
    "lab:specimen:collect",
    // Phase 6A — ward-level consumption + witnessing breakage/loss.
    "inventory:item:view",
    "inventory:stock:view",
    "inventory:stock:issue",
    "inventory:stock:reserve",
    "inventory:stock:waste",
    "procurement:requisition:create",
    "inventory:request:create", // Phase B8 — ward supply requests
    // Phase B1 — ICU clinical recording.
    "icu:flowsheet:record",
    "icu:device:manage",
    "icu:infusion:manage",
    // Phase B3 — nursing surgical workflow (checklist, specimens, implants, recovery).
    "ot:checklist:record",
    "ot:specimen:record",
    "ot:implant:record",
    "ot:recovery:manage",
    // Phase B4 — bedside receipt, bedside verification + transfusion recording,
    // observations, and reaction REPORTING (not reaction management/follow-up).
    "blood:transport:manage",
    "blood:transfusion:record",
    "blood:reaction:record",
    // Phase B5 — ED arrival/registration, reassessment, resuscitation activation,
    // and location assignment; NO disposition (a clinician decision).
    "ed:encounter:create",
    "ed:reassessment:record",
    "ed:resuscitation:manage",
    "ed:location:manage",
    // Phase B6 — ward medication requests only. NO pharmacy verification/
    // dispense/master/formulary (nursing never bypasses pharmacy verification).
    "pharmacy:request:create",
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
    // Phase B7 — LIS quality management + external-lab boundary.
    "lab:qc:manage",
    "lab:calibration:manage",
    "lab:external:manage",
    // Phase 6A — reagent/consumable consumption boundary (no dedicated UI yet).
    "inventory:item:view",
    "inventory:stock:view",
    "inventory:stock:issue",
    "inventory:stock:waste",
    "procurement:requisition:create",
    // Phase B4 — the blood-bank operator: authorized typing/crossmatch +
    // recording/verifying results, and physical unit custody (register/release/
    // quarantine/waste), reservation, issue, and dispatch.
    "blood:typing:record",
    "blood:compatibility:record",
    "blood:compatibility:verify",
    "blood:unit:manage",
    "blood:reservation:manage",
    "blood:issue",
    "blood:transport:manage",
  ],
  RADIOLOGY_TECH: [
    "hospital:command-center:view",
    "patient:read",
    "clinical:chart:read",
    "encounter:read",
    "imaging:report:enter",
    "radiology:schedule",
    "radiology:study:execute",
    // Phase 6A — contrast/disposable consumption boundary (no dedicated UI yet).
    "inventory:item:view",
    "inventory:stock:view",
    "inventory:stock:issue",
    "inventory:stock:waste",
    "procurement:requisition:create",
  ],
  PHARMACIST: [
    "hospital:command-center:view",
    "patient:read",
    "clinical:chart:read",
    "encounter:read",
    "medication:verify",
    "medication:dispense",
    // Phase 6A — pharmacy is the one fully wired-up inventory consumer this phase.
    "inventory:item:view",
    "inventory:stock:view",
    "inventory:stock:issue",
    "inventory:stock:reserve",
    "inventory:stock:transfer",
    "inventory:lot:quarantine",
    "procurement:goodsReceipt:create",
    "procurement:supplier:view",
    "inventory:report:view",
    // Phase B6 — the pharmacist operational scope. Master/formulary/recall are
    // deliberately NOT here (they are HOSPITAL_ADMIN configuration).
    "pharmacy:dispense",
    "pharmacy:return",
    "pharmacy:quarantine",
    "pharmacy:controlled:manage",
    "pharmacy:request:create",
    "pharmacy:request:fulfill",
    "pharmacy:transfer",
    "pharmacy:trace:view",
    "pharmacy:command:view",
    "pharmacy:storage:record",
    "pharmacy:substitution:authorize",
    // Phase B8 — pharmacy store also raises/fulfils generic supply requests and manages serials.
    "inventory:request:create",
    "inventory:request:fulfill",
    "inventory:serial:manage",
    "inventory:valuation:view",
  ],
  BILLING_STAFF: [
    "hospital:command-center:view",
    "patient:read",
    "encounter:read",
    "billing:view",
    "billing:charge:create",
    // Phase 5 — maker tier: create/request, never approve/void/manage pricing.
    "billing:charge:void",
    "billing:invoice:create",
    "billing:invoice:issue",
    "billing:payment:record",
    "billing:refund:request",
    "billing:adjustment:create",
    "insurance:coverage:manage",
    "insurance:preauth:manage",
    "insurance:claim:create",
    "insurance:claim:submit",
    // Phase 6A — finance visibility only, no operational inventory permission.
    "procurement:supplier:view",
    "procurement:po:view",
    "inventory:report:view",
    // Phase B8 — finance can read inventory valuation + review supplier invoices.
    "inventory:valuation:view",
    "procurement:invoice:manage",
  ],
  // Phase B8 — the dedicated procurement role Phase 6A flagged as missing. Owns
  // the RFQ->PO->receipt procurement pipeline + supplier/contract/invoice depth.
  // Separation of duties is preserved by the existing same-actor approval guards.
  PROCUREMENT_OFFICER: [
    "hospital:command-center:view",
    "inventory:item:view",
    "inventory:stock:view",
    "inventory:report:view",
    "inventory:valuation:view",
    "procurement:supplier:view",
    "procurement:supplier:manage",
    "procurement:supplier:sensitive:view",
    "procurement:requisition:approve",
    "procurement:po:view",
    "procurement:po:create",
    "procurement:po:approve",
    "procurement:po:cancel",
    "procurement:goodsReceipt:create",
    "procurement:goodsReceipt:approve",
    "procurement:rfq:manage",
    "procurement:contract:manage",
    "procurement:invoice:manage",
    "inventory:request:fulfill",
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
    "billing:charge:create", // pre-existing Phase 0 permission — the checker tier needs this too for the amount-override path (billing:adjustment:approve alone isn't the route's base gate).
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
    // Phase B7 — diagnostic quality-management oversight.
    "lab:qc:manage",
    "lab:calibration:manage",
    "lab:external:manage",
    // Phase B1 — ICU unit configuration (admin action).
    "icu:unit:manage",
    // Phase B3 — OT/procedure-catalog configuration + operational scheduling/review.
    "ot:theatre:manage",
    "ot:procedure:review",
    "ot:procedure:schedule",
    // Phase B4 — blood-bank configuration + operational management.
    "blood:configuration:manage",
    "blood:unit:manage",
    "blood:inventory:manage",
    "blood:request:review",
    "blood:reservation:manage",
    "blood:issue",
    "blood:transport:manage",
    "blood:reaction:manage",
    // Phase B5 — ED operational + administrative oversight incl. disposition.
    "ed:encounter:create",
    "ed:reassessment:record",
    "ed:resuscitation:manage",
    "ed:location:manage",
    "ed:disposition:manage",
    "ed:disposition:death",
    // Phase B6 — pharmacy configuration + policy: medication master, formulary,
    // recall management, plus operational quarantine/fulfil/transfer/trace/command.
    "pharmacy:master:manage",
    "pharmacy:formulary:manage",
    "pharmacy:recall",
    "pharmacy:quarantine",
    "pharmacy:request:fulfill",
    "pharmacy:transfer",
    "pharmacy:trace:view",
    "pharmacy:command:view",
    // Phase 5 — checker/approval tier: void/approve/manage pricing, plus reconciliation visibility.
    "billing:tariff:manage",
    "billing:package:manage",
    "billing:invoice:void",
    "billing:payment:void",
    "billing:refund:approve",
    "billing:adjustment:approve",
    "billing:reconciliation:view",
    "insurance:claim:review",
    // Checker tier also holds the maker-tier permissions (an admin can do
    // everything billing staff can, plus approve) — least-privilege still
    // holds since DOCTOR/NURSE/etc. get none of this.
    "billing:charge:void",
    "billing:invoice:create",
    "billing:invoice:issue",
    "billing:payment:record",
    "billing:refund:request",
    "billing:adjustment:create",
    "insurance:coverage:manage",
    "insurance:preauth:manage",
    "insurance:claim:create",
    "insurance:claim:submit",
    // Phase 6A — the full checker/store-manager/procurement tier. See
    // docs/PHASE_6A_PROCUREMENT.md for the documented limitation that this
    // maps every approval permission onto HOSPITAL_ADMIN alone (no
    // dedicated "Procurement Officer" role exists) — separation of duties
    // is enforced at the service layer via a same-actor guard instead.
    "inventory:item:manage",
    "inventory:location:manage",
    "inventory:stock:view",
    "inventory:stock:receive",
    "inventory:stock:transfer",
    "inventory:stock:adjust",
    "inventory:stock:waste",
    "inventory:lot:quarantine",
    "inventory:stocktake:manage",
    "inventory:report:view",
    "procurement:supplier:view",
    "procurement:supplier:manage",
    "procurement:requisition:approve",
    "procurement:po:view",
    "procurement:po:create",
    "procurement:po:approve",
    "procurement:po:cancel",
    "procurement:goodsReceipt:create",
    "procurement:goodsReceipt:approve",
    // Phase B8 — enterprise procurement + inventory oversight.
    "procurement:rfq:manage",
    "procurement:contract:manage",
    "procurement:invoice:manage",
    "procurement:supplier:sensitive:view",
    "inventory:valuation:view",
    "inventory:request:fulfill",
    "inventory:serial:manage",
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
    // Phase B5 — ED arrival/registration only (an operational front-desk action).
    // FRONT_DESK holds NO ED clinical mutation (triage/reassessment/resuscitation/
    // location/disposition) permission.
    "ed:encounter:create",
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
    // Phase 5 — cross-facility oversight only, no day-to-day billing operations.
    "billing:tariff:manage",
    "billing:reconciliation:view",
    "insurance:claim:review",
    // Phase 6A — view-only oversight, matching its existing narrow billing footprint.
    "inventory:item:view",
    "inventory:report:view",
    "procurement:po:view",
  ],
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
