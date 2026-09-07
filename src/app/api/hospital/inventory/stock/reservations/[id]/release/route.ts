import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { releaseReservation } from "@/lib/hospital/inventory/reservation";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("inventory:stock:reserve", body?.facilityId);

    const reservation = await prisma.stockReservation.findUnique({ where: { id } });
    if (!reservation || reservation.facilityId !== facilityId) throw new NotFoundError("Reservation not found.");

    const updated = await prisma.$transaction((tx) => releaseReservation(tx, id, { byUserId: session.userId }));
    await recordAuditEvent("hospital.inventory.stockReservationReleased", session.userId, { reservationId: id }, { facilityId });
    return { reservation: updated };
  });
}
