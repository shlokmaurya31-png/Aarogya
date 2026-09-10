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

describe("roleHasPermission — Phase B3 Operating Theatre boundary", () => {
  it("DOCTOR can drive the surgical clinical workflow", () => {
    for (const p of ["ot:procedure:create", "ot:procedure:review", "ot:procedure:schedule", "ot:procedure:manage", "ot:anesthesia:record", "ot:procedure:document", "ot:implant:record", "ot:specimen:record", "ot:recovery:manage"] as Permission[]) {
      expect(roleHasPermission("DOCTOR", p)).toBe(true);
    }
  });

  it("NURSE can record checklist/specimens/implants/recovery but cannot create or document the procedure", () => {
    expect(roleHasPermission("NURSE", "ot:checklist:record")).toBe(true);
    expect(roleHasPermission("NURSE", "ot:specimen:record")).toBe(true);
    expect(roleHasPermission("NURSE", "ot:implant:record")).toBe(true);
    expect(roleHasPermission("NURSE", "ot:recovery:manage")).toBe(true);
    expect(roleHasPermission("NURSE", "ot:procedure:create")).toBe(false);
    expect(roleHasPermission("NURSE", "ot:procedure:document")).toBe(false);
    expect(roleHasPermission("NURSE", "ot:anesthesia:record")).toBe(false);
  });

  it("OT/procedure configuration is HOSPITAL_ADMIN only (not DOCTOR/NURSE)", () => {
    expect(roleHasPermission("HOSPITAL_ADMIN", "ot:theatre:manage")).toBe(true);
    expect(roleHasPermission("DOCTOR", "ot:theatre:manage")).toBe(false);
    expect(roleHasPermission("NURSE", "ot:theatre:manage")).toBe(false);
  });

  it("FRONT_DESK, BILLING_STAFF, and PHARMACIST hold no surgical clinical mutation permissions", () => {
    const otPerms: Permission[] = ["ot:theatre:manage", "ot:procedure:create", "ot:procedure:schedule", "ot:procedure:manage", "ot:checklist:record", "ot:anesthesia:record", "ot:procedure:document", "ot:implant:record", "ot:specimen:record", "ot:recovery:manage"];
    for (const p of otPerms) {
      expect(roleHasPermission("FRONT_DESK", p)).toBe(false);
      expect(roleHasPermission("BILLING_STAFF", p)).toBe(false);
      expect(roleHasPermission("PHARMACIST", p)).toBe(false);
    }
  });
});

describe("roleHasPermission — Phase B4 Blood Bank boundary", () => {
  it("DOCTOR can request, review/authorize, record transfusion, and manage reactions — but not run the blood-bank inventory or lab testing", () => {
    for (const p of ["blood:request:create", "blood:request:review", "blood:transfusion:record", "blood:reaction:record", "blood:reaction:manage"] as Permission[]) {
      expect(roleHasPermission("DOCTOR", p)).toBe(true);
    }
    for (const p of ["blood:unit:manage", "blood:issue", "blood:typing:record", "blood:compatibility:verify", "blood:configuration:manage"] as Permission[]) {
      expect(roleHasPermission("DOCTOR", p)).toBe(false);
    }
  });

  it("NURSE can receive, verify+record transfusion, and REPORT reactions — but cannot manage reactions, issue, or configure", () => {
    expect(roleHasPermission("NURSE", "blood:transport:manage")).toBe(true);
    expect(roleHasPermission("NURSE", "blood:transfusion:record")).toBe(true);
    expect(roleHasPermission("NURSE", "blood:reaction:record")).toBe(true);
    expect(roleHasPermission("NURSE", "blood:reaction:manage")).toBe(false);
    expect(roleHasPermission("NURSE", "blood:issue")).toBe(false);
    expect(roleHasPermission("NURSE", "blood:request:create")).toBe(false);
    expect(roleHasPermission("NURSE", "blood:configuration:manage")).toBe(false);
  });

  it("LAB_TECHNICIAN runs typing/crossmatch and blood-bank unit custody/issue — but has no clinical request/transfusion/reaction role", () => {
    for (const p of ["blood:typing:record", "blood:compatibility:record", "blood:compatibility:verify", "blood:unit:manage", "blood:reservation:manage", "blood:issue", "blood:transport:manage"] as Permission[]) {
      expect(roleHasPermission("LAB_TECHNICIAN", p)).toBe(true);
    }
    for (const p of ["blood:request:create", "blood:transfusion:record", "blood:reaction:manage", "blood:configuration:manage"] as Permission[]) {
      expect(roleHasPermission("LAB_TECHNICIAN", p)).toBe(false);
    }
  });

  it("HOSPITAL_ADMIN owns blood-bank configuration + operational management", () => {
    for (const p of ["blood:configuration:manage", "blood:unit:manage", "blood:inventory:manage", "blood:reservation:manage", "blood:issue", "blood:reaction:manage"] as Permission[]) {
      expect(roleHasPermission("HOSPITAL_ADMIN", p)).toBe(true);
    }
  });

  it("FRONT_DESK, BILLING_STAFF, PHARMACIST, and RADIOLOGY_TECH hold no blood-bank clinical/operational mutation permissions", () => {
    const bloodPerms: Permission[] = ["blood:configuration:manage", "blood:unit:manage", "blood:inventory:manage", "blood:typing:record", "blood:compatibility:record", "blood:compatibility:verify", "blood:request:create", "blood:request:review", "blood:reservation:manage", "blood:issue", "blood:transport:manage", "blood:transfusion:record", "blood:reaction:record", "blood:reaction:manage"];
    for (const p of bloodPerms) {
      expect(roleHasPermission("FRONT_DESK", p)).toBe(false);
      expect(roleHasPermission("BILLING_STAFF", p)).toBe(false);
      expect(roleHasPermission("PHARMACIST", p)).toBe(false);
      expect(roleHasPermission("RADIOLOGY_TECH", p)).toBe(false);
    }
  });
});

describe("roleHasPermission — Phase B5 Emergency Department boundary", () => {
  it("DOCTOR can drive the full ED workflow incl. disposition and death", () => {
    for (const p of ["ed:encounter:create", "ed:reassessment:record", "ed:resuscitation:manage", "ed:location:manage", "ed:disposition:manage", "ed:disposition:death"] as Permission[]) {
      expect(roleHasPermission("DOCTOR", p)).toBe(true);
    }
  });

  it("NURSE can register/reassess/resuscitate/relocate but CANNOT disposition or record a death", () => {
    for (const p of ["ed:encounter:create", "ed:reassessment:record", "ed:resuscitation:manage", "ed:location:manage"] as Permission[]) {
      expect(roleHasPermission("NURSE", p)).toBe(true);
    }
    expect(roleHasPermission("NURSE", "ed:disposition:manage")).toBe(false);
    expect(roleHasPermission("NURSE", "ed:disposition:death")).toBe(false);
  });

  it("FRONT_DESK can register an ED arrival but holds NO ED clinical mutation permission", () => {
    expect(roleHasPermission("FRONT_DESK", "ed:encounter:create")).toBe(true);
    for (const p of ["ed:reassessment:record", "ed:resuscitation:manage", "ed:location:manage", "ed:disposition:manage", "ed:disposition:death", "clinical:note:sign"] as Permission[]) {
      expect(roleHasPermission("FRONT_DESK", p)).toBe(false);
    }
  });

  it("HOSPITAL_ADMIN holds ED operational + disposition permissions", () => {
    for (const p of ["ed:location:manage", "ed:disposition:manage", "ed:disposition:death"] as Permission[]) {
      expect(roleHasPermission("HOSPITAL_ADMIN", p)).toBe(true);
    }
  });

  it("LAB_TECHNICIAN, RADIOLOGY_TECH, PHARMACIST, and BILLING_STAFF cannot disposition an ED encounter or perform ED clinical mutations", () => {
    const edClinical: Permission[] = ["ed:reassessment:record", "ed:resuscitation:manage", "ed:location:manage", "ed:disposition:manage", "ed:disposition:death"];
    for (const p of edClinical) {
      expect(roleHasPermission("LAB_TECHNICIAN", p)).toBe(false);
      expect(roleHasPermission("RADIOLOGY_TECH", p)).toBe(false);
      expect(roleHasPermission("PHARMACIST", p)).toBe(false);
      expect(roleHasPermission("BILLING_STAFF", p)).toBe(false);
    }
  });
});

describe("roleHasPermission — Phase B6 Enterprise Pharmacy boundary", () => {
  it("PHARMACIST holds the operational pharmacy scope but NOT master/formulary/recall configuration", () => {
    for (const p of ["pharmacy:dispense", "pharmacy:return", "pharmacy:quarantine", "pharmacy:controlled:manage", "pharmacy:request:create", "pharmacy:request:fulfill", "pharmacy:transfer", "pharmacy:trace:view", "pharmacy:command:view", "pharmacy:storage:record", "pharmacy:substitution:authorize"] as Permission[]) {
      expect(roleHasPermission("PHARMACIST", p)).toBe(true);
    }
    for (const p of ["pharmacy:master:manage", "pharmacy:formulary:manage", "pharmacy:recall"] as Permission[]) {
      expect(roleHasPermission("PHARMACIST", p)).toBe(false);
    }
  });

  it("HOSPITAL_ADMIN owns pharmacy master/formulary/recall configuration", () => {
    for (const p of ["pharmacy:master:manage", "pharmacy:formulary:manage", "pharmacy:recall", "pharmacy:quarantine", "pharmacy:request:fulfill", "pharmacy:transfer"] as Permission[]) {
      expect(roleHasPermission("HOSPITAL_ADMIN", p)).toBe(true);
    }
    expect(roleHasPermission("HOSPITAL_ADMIN", "pharmacy:dispense")).toBe(false);
  });

  it("DOCTOR can raise requests, authorize substitutions, and trace — but cannot dispense or configure pharmacy", () => {
    for (const p of ["pharmacy:request:create", "pharmacy:substitution:authorize", "pharmacy:trace:view"] as Permission[]) {
      expect(roleHasPermission("DOCTOR", p)).toBe(true);
    }
    for (const p of ["pharmacy:dispense", "pharmacy:master:manage", "pharmacy:formulary:manage", "pharmacy:recall", "pharmacy:controlled:manage"] as Permission[]) {
      expect(roleHasPermission("DOCTOR", p)).toBe(false);
    }
  });

  it("NURSE can raise ward requests only — never dispense, verify, or configure pharmacy", () => {
    expect(roleHasPermission("NURSE", "pharmacy:request:create")).toBe(true);
    for (const p of ["pharmacy:dispense", "pharmacy:return", "pharmacy:master:manage", "pharmacy:formulary:manage", "pharmacy:controlled:manage", "medication:verify"] as Permission[]) {
      expect(roleHasPermission("NURSE", p)).toBe(false);
    }
  });

  it("FRONT_DESK, BILLING_STAFF, LAB_TECHNICIAN, and RADIOLOGY_TECH hold no pharmacy mutation permissions", () => {
    const pharm: Permission[] = ["pharmacy:master:manage", "pharmacy:formulary:manage", "pharmacy:dispense", "pharmacy:return", "pharmacy:quarantine", "pharmacy:recall", "pharmacy:controlled:manage", "pharmacy:request:create", "pharmacy:request:fulfill", "pharmacy:transfer", "pharmacy:substitution:authorize", "pharmacy:storage:record"];
    for (const p of pharm) {
      expect(roleHasPermission("FRONT_DESK", p)).toBe(false);
      expect(roleHasPermission("BILLING_STAFF", p)).toBe(false);
      expect(roleHasPermission("LAB_TECHNICIAN", p)).toBe(false);
      expect(roleHasPermission("RADIOLOGY_TECH", p)).toBe(false);
    }
  });
});

describe("roleHasPermission — Phase B7 Advanced Diagnostics boundary", () => {
  it("LAB_TECHNICIAN can run QC/calibration/external-lab, the specimen lifecycle, and result verify/release/amend", () => {
    for (const p of ["lab:qc:manage", "lab:calibration:manage", "lab:external:manage", "lab:specimen:collect", "lab:specimen:reject", "lab:result:enter", "lab:result:verify", "lab:result:release", "lab:result:amend"] as Permission[]) {
      expect(roleHasPermission("LAB_TECHNICIAN", p)).toBe(true);
    }
  });

  it("HOSPITAL_ADMIN holds diagnostic quality-management oversight; RADIOLOGY_TECH performs acquisition (study:execute) but not lab QC", () => {
    for (const p of ["lab:qc:manage", "lab:calibration:manage", "lab:external:manage"] as Permission[]) {
      expect(roleHasPermission("HOSPITAL_ADMIN", p)).toBe(true);
    }
    expect(roleHasPermission("RADIOLOGY_TECH", "radiology:study:execute")).toBe(true);
    for (const p of ["lab:qc:manage", "lab:calibration:manage", "lab:external:manage"] as Permission[]) {
      expect(roleHasPermission("RADIOLOGY_TECH", p)).toBe(false);
    }
  });

  it("DOCTOR acknowledges critical results but does not run the lab bench (no QC/calibration/external/result-entry)", () => {
    expect(roleHasPermission("DOCTOR", "lab:result:acknowledge")).toBe(true);
    for (const p of ["lab:qc:manage", "lab:calibration:manage", "lab:external:manage", "lab:result:enter", "lab:result:release"] as Permission[]) {
      expect(roleHasPermission("DOCTOR", p)).toBe(false);
    }
  });

  it("FRONT_DESK, BILLING_STAFF, NURSE, and PHARMACIST hold no lab QC/calibration/external-lab permissions", () => {
    for (const p of ["lab:qc:manage", "lab:calibration:manage", "lab:external:manage"] as Permission[]) {
      expect(roleHasPermission("FRONT_DESK", p)).toBe(false);
      expect(roleHasPermission("BILLING_STAFF", p)).toBe(false);
      expect(roleHasPermission("NURSE", p)).toBe(false);
      expect(roleHasPermission("PHARMACIST", p)).toBe(false);
    }
  });
});

describe("roleHasPermission — Phase B8 Enterprise Inventory + Procurement boundary", () => {
  it("PROCUREMENT_OFFICER owns the RFQ/PO/supplier/contract/invoice pipeline", () => {
    for (const p of ["procurement:rfq:manage", "procurement:contract:manage", "procurement:invoice:manage", "procurement:supplier:manage", "procurement:supplier:sensitive:view", "procurement:po:create", "procurement:po:approve", "procurement:goodsReceipt:approve", "procurement:requisition:approve", "inventory:valuation:view"] as Permission[]) {
      expect(roleHasPermission("PROCUREMENT_OFFICER", p)).toBe(true);
    }
  });

  it("PROCUREMENT_OFFICER holds no clinical mutation permissions", () => {
    for (const p of ["clinical:order:medication", "clinical:note:sign", "ed:disposition:manage", "pharmacy:dispense", "lab:result:release", "blood:issue"] as Permission[]) {
      expect(roleHasPermission("PROCUREMENT_OFFICER", p)).toBe(false);
    }
  });

  it("HOSPITAL_ADMIN retains procurement oversight incl. sensitive supplier data + valuation", () => {
    for (const p of ["procurement:rfq:manage", "procurement:contract:manage", "procurement:invoice:manage", "procurement:supplier:sensitive:view", "inventory:valuation:view"] as Permission[]) {
      expect(roleHasPermission("HOSPITAL_ADMIN", p)).toBe(true);
    }
  });

  it("clinical roles can raise supply requests but never fulfil them or read sensitive supplier data", () => {
    expect(roleHasPermission("DOCTOR", "inventory:request:create")).toBe(true);
    expect(roleHasPermission("NURSE", "inventory:request:create")).toBe(true);
    for (const p of ["inventory:request:fulfill", "procurement:supplier:sensitive:view", "procurement:rfq:manage", "procurement:contract:manage"] as Permission[]) {
      expect(roleHasPermission("DOCTOR", p)).toBe(false);
      expect(roleHasPermission("NURSE", p)).toBe(false);
    }
  });

  it("sensitive supplier data + procurement pipeline are hidden from FRONT_DESK, LAB_TECHNICIAN, and RADIOLOGY_TECH", () => {
    for (const p of ["procurement:supplier:sensitive:view", "procurement:rfq:manage", "procurement:contract:manage", "procurement:invoice:manage", "procurement:po:approve", "inventory:valuation:view"] as Permission[]) {
      expect(roleHasPermission("FRONT_DESK", p)).toBe(false);
      expect(roleHasPermission("LAB_TECHNICIAN", p)).toBe(false);
      expect(roleHasPermission("RADIOLOGY_TECH", p)).toBe(false);
    }
  });
});
