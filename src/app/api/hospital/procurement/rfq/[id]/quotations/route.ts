import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordQuotation } from "@/lib/hospital/procurement/procurementAdvanced";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("procurement:rfq:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Recording a quotation requires a procurement staff account.");
    if (!body?.supplierId || !Array.isArray(body?.lines) || body.lines.length === 0) throw new BadRequestError("supplierId and lines[] are required.");
    const quotation = await recordQuotation({ rfqId: id, facilityId, supplierId: body.supplierId, deliveryDays: body.deliveryDays, validUntil: body.validUntil ? new Date(body.validUntil) : undefined, notes: body.notes, lines: body.lines, recordedByStaffId: staff.id, byUserId: session.userId });
    return { quotation };
  });
}
