import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { createIcuUnit } from "@/lib/hospital/icu";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("hospital:command-center:view", searchParams.get("facilityId") ?? undefined);
    const units = await prisma.icuUnit.findMany({ where: { facilityId }, include: { beds: true }, orderBy: { name: "asc" } });
    return { units };
  });
}

const CreateSchema = z.object({
  name: z.string().min(1),
  icuType: z.enum(["MICU", "SICU", "CCU", "NICU", "PICU", "HDU", "GENERAL_ICU"]).optional(),
  departmentId: z.string().optional(),
  ventilatorCapable: z.boolean().optional(),
  isolationCapable: z.boolean().optional(),
  bedCapacity: z.coerce.number().int().min(0).optional(),
  notes: z.string().optional(),
  facilityId: z.string().optional(),
});

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("icu:unit:manage", body?.facilityId);
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestError("Invalid ICU unit data.");
    const unit = await createIcuUnit({ ...parsed.data, facilityId, byUserId: session.userId });
    return { unit };
  });
}
