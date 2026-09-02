import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError, ForbiddenError } from "@/lib/auth/rbac";
import type { Permission } from "@/lib/auth/permissions";
import { cancelAppointment, markNoShow, checkInAppointment, AppointmentAlreadyResolvedError, AppointmentNotCancellableError } from "@/lib/hospital/appointment";

/** Appointment lifecycle actions (brief §6/§12/§44) — cancel | noShow | checkIn | confirm. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const action = body?.action as string | undefined;

    const permissionForAction: Record<string, Permission> = {
      cancel: "appointment:cancel",
      noShow: "appointment:update",
      checkIn: "patient:checkin",
      confirm: "appointment:update",
    };
    const permission = permissionForAction[action ?? ""];
    if (!permission) throw new BadRequestError("Unknown or missing action.");

    const { session, facilityId, staff } = await requireFacilityStaff(permission, body?.facilityId);
    if (!staff) throw new ForbiddenError(permission);

    const appt = await prisma.appointment.findUnique({ where: { id } });
    if (!appt || appt.facilityId !== facilityId) throw new NotFoundError("Appointment not found.");

    try {
      if (action === "cancel") {
        const reason = body?.reason as string | undefined;
        if (!reason) throw new BadRequestError("reason is required to cancel an appointment.");
        const appointment = await cancelAppointment(id, reason, staff.id, session.userId);
        return { appointment };
      }
      if (action === "noShow") {
        const appointment = await markNoShow(id, staff.id, session.userId);
        return { appointment };
      }
      if (action === "checkIn") {
        const { appointment, encounterId } = await checkInAppointment(id, session.userId);
        return { appointment, encounterId };
      }
      if (action === "confirm") {
        if (!["REQUESTED", "RESCHEDULED"].includes(appt.status)) throw new BadRequestError(`Cannot confirm from status ${appt.status}.`);
        const appointment = await prisma.appointment.update({ where: { id }, data: { status: "CONFIRMED" } });
        return { appointment };
      }
      throw new BadRequestError("Unknown action.");
    } catch (err) {
      if (err instanceof AppointmentAlreadyResolvedError || err instanceof AppointmentNotCancellableError) {
        throw new BadRequestError(err.message);
      }
      throw err;
    }
  });
}
