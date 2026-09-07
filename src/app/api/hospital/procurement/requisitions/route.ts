import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { prisma } from "@/lib/db";
import { createRequisitionDraft, addRequisitionLine } from "@/lib/hospital/procurement/requisitions";
import { clampPageSize } from "@/lib/hospital/inventory/expiry";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("procurement:requisition:create", searchParams.get("facilityId") ?? undefined);
    const cursor = searchParams.get("cursor") ?? undefined;
    const requisitions = await prisma.purchaseRequisition.findMany({
      where: { facilityId, ...(searchParams.get("status") ? { status: searchParams.get("status") as never } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: clampPageSize(searchParams.get("take") ? Number(searchParams.get("take")) : undefined),
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: { lines: true },
    });
    return { requisitions };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { facilityId, staff } = await requireFacilityStaff("procurement:requisition:create", body?.facilityId);
    if (!staff) throw new BadRequestError("Creating a requisition must be performed by a staff account.");

    const { departmentId, justification, lines } = body ?? {};
    if (!departmentId) throw new BadRequestError("departmentId is required.");
    if (!justification) throw new BadRequestError("justification is required.");
    if (!Array.isArray(lines) || lines.length === 0) throw new BadRequestError("At least one line is required.");

    const requisition = await prisma.$transaction(async (tx) => {
      const draft = await createRequisitionDraft(tx, {
        facilityId,
        departmentId,
        requestedByStaffId: staff.id,
        justification,
        priority: body?.priority,
        requiredByDate: body?.requiredByDate ? new Date(body.requiredByDate) : undefined,
      });
      for (const line of lines) {
        await addRequisitionLine(tx, draft.id, { itemId: line.itemId, quantity: line.quantity, unit: line.unit, notes: line.notes });
      }
      return tx.purchaseRequisition.findUniqueOrThrow({ where: { id: draft.id }, include: { lines: true } });
    });
    return { requisition };
  });
}
