import type { PrismaClient } from "@prisma/client";

/**
 * Demo licensure rows so the gates in src/lib/hospital/workforce/licensure.ts
 * pass for seeded staff. Without these, every demo doctor would be refused at
 * prescribing. Idempotent: only adds a row a staff member doesn't already hold.
 *
 * Synthetic data: "VERIFIED" here means verified by the demo hospital's
 * workflow, never by a real council registry.
 */
const FIVE_YEARS_MS = 5 * 365 * 24 * 3600_000;

const CREDENTIALS_BY_ROLE: Record<string, { name: string; category: string; issuingAuthority: string }> = {
  DOCTOR: { name: "State Medical Council Registration", category: "MEDICAL_COUNCIL", issuingAuthority: "State Medical Council (demo)" },
  PHARMACIST: { name: "State Pharmacy Council Registration", category: "PHARMACY_COUNCIL", issuingAuthority: "State Pharmacy Council (demo)" },
};

const PRIVILEGES_BY_ROLE: Record<string, string[]> = {
  LAB_TECHNICIAN: ["LAB_RESULT_VERIFY", "BLOOD_BANK_VERIFY"],
  RADIOLOGY_TECH: ["RADIOLOGY_REPORT_FINALIZE"],
};

export async function seedDemoLicensure(prisma: PrismaClient) {
  const staffRows = await prisma.hospitalStaffProfile.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, user: { select: { role: true, facilityMemberships: { where: { isPrimary: true }, select: { facilityId: true } } } } },
  });
  // D8: the staff member's facility is their primary membership.
  const staff = staffRows.flatMap((s) => (s.user.facilityMemberships[0] ? [{ ...s, facilityId: s.user.facilityMemberships[0].facilityId }] : []));
  const admins = new Map<string, string>();
  for (const s of staff) if (s.user.role === "HOSPITAL_ADMIN" && !admins.has(s.facilityId)) admins.set(s.facilityId, s.id);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + FIVE_YEARS_MS);
  let credentials = 0;
  let privileges = 0;

  for (const s of staff) {
    const grantedBy = admins.get(s.facilityId) ?? s.id;
    const cred = CREDENTIALS_BY_ROLE[s.user.role];
    if (cred) {
      const has = await prisma.credential.findFirst({ where: { staffId: s.id, facilityId: s.facilityId, credentialType: "REGISTRATION" } });
      if (!has) {
        await prisma.credential.create({
          data: {
            facilityId: s.facilityId, staffId: s.id, credentialType: "REGISTRATION", ...cred,
            credentialNumber: `DEMO-REG-${s.id.slice(-6).toUpperCase()}`,
            issuedAt: now, expiresAt, status: "VERIFIED", verifiedByStaffId: grantedBy, verifiedAt: now,
            createdByStaffId: grantedBy, notes: "Synthetic demo credential.",
          },
        });
        credentials++;
      }
    }
    for (const privilegeType of PRIVILEGES_BY_ROLE[s.user.role] ?? []) {
      const has = await prisma.staffPrivilege.findFirst({ where: { staffId: s.id, facilityId: s.facilityId, privilegeType } });
      if (!has) {
        await prisma.staffPrivilege.create({
          data: { facilityId: s.facilityId, staffId: s.id, privilegeType, status: "ACTIVE", grantedByStaffId: grantedBy, expiresAt, notes: "Synthetic demo privilege." },
        });
        privileges++;
      }
    }
  }
  console.log(`Demo licensure: ${credentials} credential(s), ${privileges} privilege(s) added.`);
}
