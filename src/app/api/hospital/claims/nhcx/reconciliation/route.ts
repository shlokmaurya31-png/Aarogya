import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { buildAuthorizationActor } from "@/lib/auth/authorize/context";
import { requireAuthorization } from "@/lib/auth/authorize/engine";
import {
  recordSettlement, reconcileSettlement, reconcileClaim,
  resolveException, listExceptions,
} from "@/lib/hospital/nhcx/reconciliation";

/**
 * Phase C5 — settlement recording and reconciliation.
 *
 * Reconciliation REPORTS discrepancies; it never silently corrects one. No route
 * here creates, amends or deletes a canonical Payment — moving money stays with
 * the Phase 5 billing services and an authorized human.
 */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const actor = await buildAuthorizationActor(searchParams.get("facilityId") ?? undefined);
    await requireAuthorization({
      actor, action: "claim.reconcile",
      resource: { type: "CLAIM", facilityId: actor.facilityId, dataClass: "FINANCIAL" },
    });
    if (!actor.facilityId) throw new BadRequestError("A facility is required.");

    const facilityId = actor.facilityId;
    const [settlements, exceptions] = await Promise.all([
      prisma.claimSettlement.findMany({
        where: { facilityId, ...(searchParams.get("claimId") ? { claimId: searchParams.get("claimId")! } : {}) },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
      listExceptions({ facilityId, status: searchParams.get("status") ?? undefined }),
    ]);

    return { settlements, exceptions };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const actor = await buildAuthorizationActor(body?.facilityId);
    if (!actor.facilityId) throw new BadRequestError("A facility is required.");

    await requireAuthorization({
      actor, action: "claim.reconcile",
      resource: { type: "CLAIM", facilityId: actor.facilityId, dataClass: "FINANCIAL" },
    });

    switch (body?.action) {
      case "recordSettlement": {
        // The amount is validated as an integer inside recordSettlement; an
        // operator transcribing a payer advice is still an untrusted source.
        return {
          settlement: await recordSettlement({
            facilityId: actor.facilityId,
            claimId: String(body.claimId ?? ""),
            externalSettlementRef: String(body.externalSettlementRef ?? ""),
            settledAmountMinor: body.settledAmountMinor,
            settlementDate: body.settlementDate ? new Date(body.settlementDate) : null,
            notes: body.notes ? String(body.notes).slice(0, 1000) : undefined,
            byUserId: actor.userId,
          }),
        };
      }

      case "reconcileSettlement": {
        if (!body?.settlementId) throw new BadRequestError("settlementId is required.");
        return {
          settlement: await reconcileSettlement({
            facilityId: actor.facilityId,
            settlementId: String(body.settlementId),
            paymentId: body.paymentId ? String(body.paymentId) : null,
            byUserId: actor.userId,
            note: body.note ? String(body.note).slice(0, 1000) : undefined,
          }),
        };
      }

      case "reconcileClaim": {
        if (!body?.claimId) throw new BadRequestError("claimId is required.");
        return reconcileClaim({
          facilityId: actor.facilityId,
          claimId: String(body.claimId),
          byUserId: actor.userId,
        });
      }

      case "resolveException": {
        if (!body?.exceptionId) throw new BadRequestError("exceptionId is required.");
        return {
          exception: await resolveException({
            facilityId: actor.facilityId,
            exceptionId: String(body.exceptionId),
            to: String(body.to ?? ""),
            note: body.note ? String(body.note).slice(0, 1000) : undefined,
            byUserId: actor.userId,
          }),
        };
      }

      default:
        throw new BadRequestError(
          "action must be recordSettlement, reconcileSettlement, reconcileClaim or resolveException."
        );
    }
  });
}
