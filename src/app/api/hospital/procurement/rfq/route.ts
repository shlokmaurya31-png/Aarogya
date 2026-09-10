import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { createRfq } from "@/lib/hospital/procurement/procurementAdvanced";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("procurement:rfq:manage", searchParams.get("facilityId") ?? undefined);
    const status = searchParams.get("status");
    const rfqs = await prisma.rfq.findMany({ where: { facilityId, ...(status ? { status: status as never } : {}) }, include: { lines: true, quotations: { select: { id: true, supplierId: true, totalMinor: true, status: true, selected: true } } }, orderBy: { createdAt: "desc" }, take: 100 });
    return { rfqs };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("procurement:rfq:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("RFQ creation requires a procurement staff account.");
    if (!Array.isArray(body?.lines) || body.lines.length === 0) throw new BadRequestError("lines[] is required.");
    const rfq = await createRfq({ facilityId, requisitionId: body.requisitionId, validUntil: body.validUntil ? new Date(body.validUntil) : undefined, notes: body.notes, lines: body.lines, createdByStaffId: staff.id, byUserId: session.userId });
    return { rfq };
  });
}
