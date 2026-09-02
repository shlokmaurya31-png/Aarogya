import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError, ForbiddenError } from "@/lib/auth/rbac";
import type { Permission } from "@/lib/auth/permissions";
import {
  acceptTransferRequest, reserveBedForTransfer, markPatientInTransit, completeTransferRequest, cancelTransferRequest,
  TransferRequestNotActionableError, TransferSafetyError,
} from "@/lib/hospital/transferRequest";
import { BedNotAvailableError } from "@/lib/hospital/admission";
import { InvalidBedTransitionError } from "@/lib/hospital/bed";

const PERMISSION_FOR_ACTION: Record<string, Permission> = {
  accept: "transfer:approve",
  reserveBed: "transfer:approve",
  markInTransit: "transfer:execute",
  complete: "transfer:execute",
  cancel: "transfer:approve",
};

/** Transfer-request lifecycle actions (brief §34) — accept | reserveBed | markInTransit | complete | cancel. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const action = body?.action as string | undefined;
    const permission = PERMISSION_FOR_ACTION[action ?? ""];
    if (!permission) throw new BadRequestError("Unknown or missing action.");

    const { session, facilityId, staff } = await requireFacilityStaff(permission, body?.facilityId);
    if (!staff) throw new ForbiddenError(permission);

    const request = await prisma.transferRequest.findUnique({ where: { id } });
    if (!request || request.facilityId !== facilityId) throw new NotFoundError("Transfer request not found.");

    try {
      if (action === "accept") return { request: await acceptTransferRequest(id, staff.id, session.userId) };
      if (action === "reserveBed") {
        const bedId = body?.bedId as string | undefined;
        if (!bedId) throw new BadRequestError("bedId is required.");
        return { request: await reserveBedForTransfer(id, bedId, session.userId) };
      }
      if (action === "markInTransit") return { request: await markPatientInTransit(id) };
      if (action === "complete") {
        const { request: updated, transfer } = await completeTransferRequest(id, session.userId);
        return { request: updated, transfer };
      }
      if (action === "cancel") return { request: await cancelTransferRequest(id, session.userId) };
      throw new BadRequestError("Unknown action.");
    } catch (err) {
      if (
        err instanceof TransferRequestNotActionableError ||
        err instanceof TransferSafetyError ||
        err instanceof BedNotAvailableError ||
        err instanceof InvalidBedTransitionError
      ) {
        throw new BadRequestError(err.message);
      }
      throw err;
    }
  });
}
