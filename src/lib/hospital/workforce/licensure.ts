import { prisma } from "@/lib/db";
import { requireCredential, requirePrivilege } from "./authorization";

/**
 * Licensure gates for the clinical actions where acting without a current
 * licence or granted privilege is unlawful or unsafe. One table, so the
 * policy is reviewable in one place. Everything else stays RBAC-only, per the
 * "start small" rule in src/lib/auth/authorize/policies.ts.
 *
 * Credentials (Credential rows) are statutory registrations: state medical /
 * pharmacy council. Privileges (StaffPrivilege rows) are facility grants for
 * sign-off work. Both must be ACTIVE/VERIFIED and unexpired; expiry is derived
 * from dates at check time, so a lapsed licence blocks immediately.
 */
export const LICENSURE_REQUIREMENTS = {
  /** Writing a medication order (prescribing): medical council registration. */
  prescribe: { kind: "credential", type: "REGISTRATION" },
  /** Dispensing medication: pharmacy council registration. */
  dispense: { kind: "credential", type: "REGISTRATION" },
  /** Releasing a lab result into the chart. */
  labResultRelease: { kind: "privilege", type: "LAB_RESULT_VERIFY" },
  /** Entering/finalising an imaging report. */
  imagingReportFinalize: { kind: "privilege", type: "RADIOLOGY_REPORT_FINALIZE" },
  /** Verifying blood compatibility before issue. */
  bloodCompatibilityVerify: { kind: "privilege", type: "BLOOD_BANK_VERIFY" },
} as const;

export type LicensedAction = keyof typeof LICENSURE_REQUIREMENTS;

/**
 * Throws CredentialAuthorizationError (HTTP 403 via withApiErrors) when the
 * staff member lacks what `action` requires. AAROGYA_ADMIN has no staff
 * profile and no per-facility licence rows; it is exempt, matching
 * enforcePrivilegeForContext.
 */
export async function enforceLicensure(
  ctx: { staff: { id: string } | null; facilityId: string },
  action: LicensedAction
): Promise<void> {
  if (!ctx.staff) return;
  const req = LICENSURE_REQUIREMENTS[action];
  const args = { staffId: ctx.staff.id, facilityId: ctx.facilityId };
  if (req.kind === "credential") await requireCredential(prisma, { ...args, credentialType: req.type });
  else await requirePrivilege(prisma, { ...args, privilegeType: req.type });
}
