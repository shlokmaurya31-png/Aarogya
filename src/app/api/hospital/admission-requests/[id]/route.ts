import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError, ForbiddenError } from "@/lib/auth/rbac";
import type { Permission } from "@/lib/auth/permissions";
import {
  allocateBed, releaseReservation, deferRequest, rejectRequest, cancelRequest, confirmAdmissionRequest,
  AdmissionRequestNotPendingError,
} from "@/lib/hospital/admissionRequest";
import { BedNotAvailableError, InvalidEncounterTransitionError } from "@/lib/hospital/admission";
import { InvalidBedTransitionError } from "@/lib/hospital/bed";

const PERMISSION_FOR_ACTION: Record<string, Permission> = {
  allocate: "admission:allocate",
  releaseReservation: "admission:allocate",
  defer: "admission:approve",
  reject: "admission:approve",
  cancel: "admission:approve",
  confirm: "admission:allocate",
};

/** Admission-request lifecycle actions (brief §29-32) — allocate | releaseReservation | defer | reject | cancel | confirm. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const action = body?.action as string | undefined;
    const permission = PERMISSION_FOR_ACTION[action ?? ""];
    if (!permission) throw new BadRequestError("Unknown or missing action.");

    const { session, facilityId, staff } = await requireFacilityStaff(permission, body?.facilityId);
    if (!staff) throw new ForbiddenError(permission);

    const request = await prisma.admissionRequest.findUnique({ where: { id } });
    if (!request || request.facilityId !== facilityId) throw new NotFoundError("Admission request not found.");

    try {
      if (action === "allocate") {
        const bedId = body?.bedId as string | undefined;
        if (!bedId) throw new BadRequestError("bedId is required.");
        return { request: await allocateBed(id, bedId, staff.id, session.userId) };
      }
      if (action === "releaseReservation") return { request: await releaseReservation(id, session.userId) };
      if (action === "defer") return { request: await deferRequest(id) };
      if (action === "reject") {
        const reason = body?.reason as string | undefined;
        if (!reason) throw new BadRequestError("reason is required to reject.");
        return { request: await rejectRequest(id, reason, staff.id, session.userId) };
      }
      if (action === "cancel") return { request: await cancelRequest(id, session.userId) };
      if (action === "confirm") {
        const { request: updated, admission } = await confirmAdmissionRequest(id, session.userId);
        return { request: updated, admission };
      }
      throw new BadRequestError("Unknown action.");
    } catch (err) {
      if (
        err instanceof AdmissionRequestNotPendingError ||
        err instanceof BedNotAvailableError ||
        err instanceof InvalidEncounterTransitionError ||
        err instanceof InvalidBedTransitionError
      ) {
        throw new BadRequestError(err.message);
      }
      throw err;
    }
  });
}
