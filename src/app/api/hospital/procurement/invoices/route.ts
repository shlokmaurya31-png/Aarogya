import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordSupplierInvoice } from "@/lib/hospital/procurement/procurementAdvanced";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("procurement:invoice:manage", searchParams.get("facilityId") ?? undefined);
    const status = searchParams.get("status");
    const invoices = await prisma.supplierInvoice.findMany({ where: { facilityId, ...(status ? { status: status as never } : {}) }, include: { supplier: { select: { name: true, code: true } } }, orderBy: { createdAt: "desc" }, take: 200 });
    return { invoices };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("procurement:invoice:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Invoice recording requires a procurement staff account.");
    if (!body?.supplierId || !body?.invoiceRef || body?.totalMinor == null) throw new BadRequestError("supplierId, invoiceRef, and totalMinor are required.");
    const invoice = await recordSupplierInvoice({ facilityId, supplierId: body.supplierId, invoiceRef: body.invoiceRef, totalMinor: Number(body.totalMinor), purchaseOrderId: body.purchaseOrderId, invoiceDate: body.invoiceDate ? new Date(body.invoiceDate) : undefined, recordedByStaffId: staff.id, notes: body.notes, byUserId: session.userId });
    return { invoice };
  });
}
