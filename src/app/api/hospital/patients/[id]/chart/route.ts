import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import { noteStaffChartRead } from "@/lib/doctors/self";
import { CHART_SECTIONS, chartFirstPage, chartSectionPage, type ChartSection } from "@/lib/hospital/chart";

/**
 * The unified longitudinal patient record (brief §69/§108): every
 * encounter, note, order and result for this patient, queried across
 * encounter types rather than siloed per visit. Flagship 2d: in pages.
 *
 *   GET            the patient, the summary header and each section's first page
 *   GET ?section=labOrders&cursor=…&limit=50   the next page of one section
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    // Milestone E hardening — clinical:chart:read, not patient:read (which
    // over-granted the full record to FRONT_DESK/BILLING_STAFF).
    const { session, facilityId } = await requireFacilityStaff("clinical:chart:read", searchParams.get("facilityId") ?? undefined);
    const { id } = await params;

    const patient = await prisma.patient.findUnique({
      where: { id },
      select: { id: true, facilityId: true, uhid: true, fullName: true, sex: true, dob: true, dobPrecision: true, phone: true, bloodGroup: true },
    });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");
    // 5b follow-up: reading one's own chart as staff is allowed, recorded as SELF_ACCESS (src/lib/doctors/self.ts).
    await noteStaffChartRead({ userId: session.userId, facilityId }, patient.id, "CHART");

    const section = searchParams.get("section");
    if (section !== null) {
      if (!(CHART_SECTIONS as readonly string[]).includes(section)) throw new BadRequestError("Unknown section.");
      const limit = searchParams.get("limit");
      return { section, ...(await chartSectionPage(patient.id, section as ChartSection, { cursor: searchParams.get("cursor"), limit: limit ? Number(limit) || undefined : undefined })) };
    }
    const { facilityId: _f, ...shown } = patient;
    return { patient: shown, ...(await chartFirstPage(patient.id)) };
  });
}
