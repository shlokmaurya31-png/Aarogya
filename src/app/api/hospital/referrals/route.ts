import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId, staff } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);
    const scope = searchParams.get("scope"); // "incoming" | undefined (all for facility)

    const referrals = await prisma.referral.findMany({
      where: {
        encounter: { facilityId },
        ...(scope === "incoming" && staff ? { toStaffId: staff.id } : {}),
      },
      include: { patient: true, fromStaff: { include: { user: true } }, toStaff: { include: { user: true } }, fromDepartment: true, toDepartment: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return { referrals };
  });
}

/** Referral (brief §22/§161) — uses the generalized order lifecycle since this is a brand-new entity, see docs/CLINICAL_CORE.md §5. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("referral:create", body?.facilityId);
    if (!staff) throw new BadRequestError("Referrals must be created by a staff account.");

    const { encounterId, toDepartmentId, toStaffId, reason, priority } = body ?? {};
    if (!encounterId || !reason) throw new BadRequestError("encounterId and reason are required.");

    const encounter = await prisma.encounter.findUnique({ where: { id: encounterId } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");

    const referral = await prisma.referral.create({
      data: {
        patientId: encounter.patientId,
        encounterId,
        fromDepartmentId: encounter.departmentId,
        toDepartmentId,
        fromStaffId: staff.id,
        toStaffId,
        reason,
        priority: priority ?? "ROUTINE",
        status: "PLACED",
      },
    });

    await recordAuditEvent("hospital.referral.created", session.userId, { referralId: referral.id, encounterId });
    return { referral };
  });
}
