import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import { noteStaffChartRead } from "@/lib/doctors/self";
import { labTrend } from "@/lib/hospital/labTrend";

/** GET ?test=Haemoglobin: one test over time, this hospital's results and the imported ones (labelled "imported"). Flagship 5. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const q = req.nextUrl.searchParams;
    const { session, facilityId } = await requireFacilityStaff("clinical:chart:read", q.get("facilityId") ?? undefined);
    const test = (q.get("test") ?? "").trim();
    if (!test || test.length > 120) throw new BadRequestError("test (the test's name) is required.");
    const patient = await prisma.patient.findUnique({ where: { id: (await params).id }, select: { id: true, facilityId: true } });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");
    await noteStaffChartRead({ userId: session.userId, facilityId }, patient.id, "CHART");
    return labTrend(patient.id, test);
  });
}
