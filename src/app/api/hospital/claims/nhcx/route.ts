import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { buildAuthorizationActor } from "@/lib/auth/authorize/context";
import { requireAuthorization } from "@/lib/auth/authorize/engine";
import { buildClaimPackage } from "@/lib/hospital/nhcx/claimPackage";
import { buildSubmission, dispatchSubmission, retryExchange } from "@/lib/hospital/nhcx/submission";
import { getNhcxAdapter } from "@/lib/hospital/nhcx/adapter";
import { getNhcxConfig, describeNhcxConfig, checkNhcxEnvironmentSafety } from "@/lib/hospital/nhcx/config";
import { describeContract } from "@/lib/hospital/nhcx/contract";

/**
 * Phase C5 — NHCX claims exchange.
 *
 * Every identity input is server-derived. The client names a claim and an
 * action; the actor, facility, patient, payer and every monetary amount come
 * from the session and canonical records.
 *
 * Amounts in particular are NEVER read from the body — a claim total is a
 * financial assertion and is always recomputed from InvoiceLine rows.
 */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const actor = await buildAuthorizationActor(searchParams.get("facilityId") ?? undefined);
    const claimId = searchParams.get("claimId");

    // Pre-flight checklist for one claim.
    if (claimId) {
      const claim = await prisma.claim.findUnique({ where: { id: claimId }, include: { invoice: true } });
      await requireAuthorization({
        actor,
        action: "claim.read",
        resource: {
          type: "CLAIM", id: claimId, facilityId: actor.facilityId,
          patientId: claim?.invoice.patientId ?? null, dataClass: "FINANCIAL",
        },
      });
      if (!actor.facilityId) throw new BadRequestError("A facility is required.");

      const pkg = await buildClaimPackage({ claimId, facilityId: actor.facilityId, actor });
      const submissions = await prisma.claimSubmission.findMany({
        where: { facilityId: actor.facilityId, claimId },
        orderBy: { version: "desc" },
        select: {
          id: true, version: true, submissionType: true, status: true,
          claimedAmountMinor: true, approvedAmountMinor: true, snapshotHash: true,
          correctionReason: true, builtAt: true, submittedAt: true, respondedAt: true,
        },
      });
      const exchanges = await prisma.nhcxExchange.findMany({
        where: { facilityId: actor.facilityId, claimId },
        orderBy: { requestedAt: "desc" },
      });

      return {
        package: pkg,
        // The pre-flight checklist: submission is refused while any blocker stands.
        readiness: {
          submittable: pkg.blockers.length === 0,
          blockers: pkg.blockers,
          warnings: pkg.warnings,
          excludedDocuments: pkg.excludedDocuments,
        },
        submissions,
        exchanges,
      };
    }

    // Operational overview.
    await requireAuthorization({
      actor, action: "claim.read",
      resource: { type: "CLAIM", facilityId: actor.facilityId, dataClass: "FINANCIAL" },
    });
    if (!actor.facilityId) throw new BadRequestError("A facility is required.");

    const facilityId = actor.facilityId;
    const [claims, exchanges, failed, exceptions, queries] = await Promise.all([
      prisma.claim.groupBy({ by: ["status"], where: { facilityId }, _count: true }),
      prisma.nhcxExchange.groupBy({ by: ["protocolState"], where: { facilityId }, _count: true }),
      prisma.nhcxExchange.findMany({
        where: { facilityId, protocolState: "FAILED" },
        orderBy: { updatedAt: "desc" }, take: 50,
      }),
      prisma.reconciliationException.count({ where: { facilityId, status: "OPEN" } }),
      prisma.claimQuery.count({ where: { facilityId, status: { in: ["RECEIVED", "UNDER_REVIEW", "RESPONSE_DRAFT"] } } }),
    ]);

    const config = getNhcxConfig();
    const safety = checkNhcxEnvironmentSafety(config);
    const capabilities = await getNhcxAdapter().capabilities();

    return {
      claimsByStatus: claims,
      exchangesByState: exchanges,
      failedExchanges: failed,
      openExceptions: exceptions,
      openQueries: queries,
      // Runtime truth, not stored intent. No secret is included.
      connectivity: {
        config: describeNhcxConfig(config),
        capabilities,
        safe: safety.safe,
        warning: safety.warning,
        contract: describeContract(),
      },
    };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const actor = await buildAuthorizationActor(body?.facilityId);
    if (!actor.facilityId) throw new BadRequestError("A facility is required.");
    if (!body?.action) throw new BadRequestError("action is required.");

    switch (body.action) {
      case "build": {
        if (!body?.claimId) throw new BadRequestError("claimId is required.");
        const result = await buildSubmission({
          claimId: body.claimId,
          facilityId: actor.facilityId,
          actor,
          submissionType: body.submissionType,
          correctionReason: body.correctionReason,
        });
        return {
          submission: {
            id: result.submission.id, version: result.submission.version,
            status: result.submission.status, claimedAmountMinor: result.submission.claimedAmountMinor,
            snapshotHash: result.submission.snapshotHash,
          },
          warnings: result.warnings,
          excludedDocuments: result.excludedDocuments,
        };
      }

      case "dispatch": {
        if (!body?.submissionId) throw new BadRequestError("submissionId is required.");
        const result = await dispatchSubmission({
          submissionId: body.submissionId, facilityId: actor.facilityId, actor,
        });
        return {
          exchange: {
            id: result.exchange.id, protocolState: result.exchange.protocolState,
            correlationId: result.exchange.correlationId,
            externalReference: result.exchange.externalReference,
            errorCategory: result.exchange.errorCategory,
            attemptCount: result.exchange.attemptCount,
          },
          deduplicated: result.deduplicated,
          // Surfaced verbatim so an operator sees the honest transport state
          // rather than a success-shaped placeholder.
          adapterMessage: result.result?.message ?? null,
          adapterOutcome: result.result?.outcome ?? null,
        };
      }

      case "retry": {
        if (!body?.exchangeId) throw new BadRequestError("exchangeId is required.");
        const exchange = await retryExchange({
          exchangeId: body.exchangeId, facilityId: actor.facilityId, actor,
        });
        return { exchange };
      }

      default:
        throw new BadRequestError("action must be build, dispatch or retry.");
    }
  });
}
