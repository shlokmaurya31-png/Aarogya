import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

/** Episode of Care (brief §11 / docs/TARGET_DOMAIN_ARCHITECTURE.md §2.1). */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);
    const patientId = searchParams.get("patientId");
    if (!patientId) throw new BadRequestError("patientId is required.");

    const patient = await prisma.patient.findUnique({ where: { id: patientId } });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");

    const episodes = await prisma.episodeOfCare.findMany({
      where: { patientId },
      include: { encounters: true },
      orderBy: { openedAt: "desc" },
    });
    return { episodes };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("episode:manage", body?.facilityId);

    const { patientId, title, type, reason } = body ?? {};
    if (!patientId || !title || !type) throw new BadRequestError("patientId, title and type are required.");

    const patient = await prisma.patient.findUnique({ where: { id: patientId } });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");

    const episode = await prisma.episodeOfCare.create({
      data: { patientId, facilityId, title, type, reason },
    });

    await recordAuditEvent("hospital.episode.created", session.userId, { episodeId: episode.id, patientId });
    return { episode };
  });
}
