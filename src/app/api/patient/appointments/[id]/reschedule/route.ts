import { NextRequest } from "next/server";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requirePatientActor, resolveActScope } from "@/lib/patient/context";
import { reschedulePatientAppointment } from "@/lib/patient/experience/appointments";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const ctx = await requirePatientActor();
    const scope = await resolveActScope(ctx);
    const body = await req.json().catch(() => ({}));
    if (typeof body?.scheduledStart !== "string") throw new BadRequestError("A new time is required.");
    const appt = await reschedulePatientAppointment(scope, ctx.userId, id, body.scheduledStart);
    return { ok: true, appointmentId: appt.id };
  });
}
