import { NextRequest } from "next/server";
import { z } from "zod";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requirePatientContext, requirePatientActor, resolveReadScope, resolveActScope } from "@/lib/patient/context";
import { listAppointments, requestAppointment } from "@/lib/patient/experience/appointments";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const ctx = await requirePatientContext();
    const { searchParams } = new URL(req.url);
    const scope = await resolveReadScope(ctx, searchParams.get("patientId"));
    return listAppointments(scope);
  });
}

const BookSchema = z.object({
  doctorStaffId: z.string().min(1),
  scheduledStart: z.string().min(1),
  reason: z.string().max(500).optional(),
  type: z.enum(["NEW", "FOLLOW_UP"]).optional(),
}).strict();

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const ctx = await requirePatientActor();
    const scope = await resolveActScope(ctx); // self only — a delegate cannot book
    const parsed = BookSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError("A doctor and a valid time are required.");
    const appt = await requestAppointment(scope, ctx.userId, parsed.data);
    return { ok: true, appointmentId: appt.id };
  });
}
