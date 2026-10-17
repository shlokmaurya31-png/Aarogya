import { prisma } from "@/lib/db";
import type { DomainEventConsumer } from "@/lib/events/consumers";
import { PermanentEventError } from "@/lib/events/types";
import { createClaimDraft } from "@/lib/hospital/billing/claims";
import { createTask, closeTask, OPEN_STATUSES } from "@/lib/hospital/task";

/**
 * claim-drafting (workflow spine §2): an issued invoice whose patient has an
 * ACTIVE coverage, valid on the issue date, gets a DRAFT claim against the
 * primary coverage (lowest priorityOrder), with the encounter's unclaimed
 * APPROVED pre-authorization on that coverage if there is one. The claim is
 * never submitted here: submission stays a human action.
 *
 *   HospitalInvoiceIssued   → Claim (DRAFT) via createClaimDraft
 *                             no pre-authorization → one CLAIM_PREAUTH_MISSING
 *                             task for billing (the blocker)
 *   ClaimSubmitted, ClaimStatusChanged (REJECTED, CLOSED)
 *                           → that task is closed (a person has decided)
 *
 * Idempotent: Claim.invoiceId is unique, so an invoice that already has a
 * claim (drafted by staff, or by an earlier delivery) is skipped; a concurrent
 * insert loses on the constraint and is treated the same way. No coverage →
 * processed, nothing written. Re-reads everything and checks the tenant.
 */
const PREAUTH_MISSING = "CLAIM_PREAUTH_MISSING";

async function draftFor(invoiceId: string, facilityId: string | null, actorUserId: string | null) {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, facilityId: true, encounterId: true, patientId: true, status: true, issuedAt: true, generatedByUserId: true, claim: { select: { id: true } } },
  });
  if (!invoice) throw new PermanentEventError(`Invoice ${invoiceId} not found.`, "NOT_FOUND");
  if (invoice.facilityId !== facilityId) throw new PermanentEventError(`Invoice ${invoiceId} is not in the event's facility.`, "TENANT_MISMATCH");
  if (invoice.status === "VOID" || invoice.claim) return;

  const at = invoice.issuedAt ?? new Date();
  const coverage = await prisma.patientCoverage.findFirst({
    where: { patientId: invoice.patientId, status: "ACTIVE", validFrom: { lte: at }, OR: [{ validTo: null }, { validTo: { gte: at } }] },
    orderBy: [{ priorityOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  if (!coverage) return;
  const preAuth = await prisma.preAuthorization.findFirst({
    where: { encounterId: invoice.encounterId, coverageId: coverage.id, status: "APPROVED", claim: null },
    orderBy: [{ decidedAt: "desc" }, { id: "asc" }],
    select: { id: true },
  });

  try {
    await prisma.$transaction(async (tx) => {
      const claim = await createClaimDraft(tx, {
        invoiceId: invoice.id, coverageId: coverage.id, facilityId: invoice.facilityId, preAuthorizationId: preAuth?.id,
        createdByUserId: actorUserId ?? invoice.generatedByUserId,
      });
      if (!preAuth) {
        await createTask(tx, {
          facilityId: invoice.facilityId, patientId: invoice.patientId, encounterId: invoice.encounterId,
          type: PREAUTH_MISSING, title: "Claim drafted without an approved pre-authorization: review before submitting",
          priority: "URGENT", assignedRole: "BILLING_STAFF", source: "EVENT", idempotencyKey: `${PREAUTH_MISSING}:${claim.id}`,
        }, actorUserId);
      }
    });
  } catch (err) {
    // Lost the race to a concurrent draft for the same invoice: it is claimed.
    if ((err as { code?: string }).code === "P2002") return;
    throw err;
  }
}

async function closeBlocker(claimId: string, facilityId: string | null, actorUserId: string | null) {
  if (!facilityId) return;
  await prisma.$transaction(async (tx) => {
    const task = await tx.task.findFirst({
      where: { facilityId, idempotencyKey: `${PREAUTH_MISSING}:${claimId}`, source: "EVENT", status: { in: OPEN_STATUSES } },
      select: { id: true },
    });
    if (task) await closeTask(tx, task.id, "COMPLETED", { completedAt: new Date() }, actorUserId);
  });
}

export const claimDrafting: DomainEventConsumer = {
  name: "claim-drafting",
  handles: ["HospitalInvoiceIssued", "ClaimSubmitted", "ClaimStatusChanged"],
  async handle(event) {
    const p = event.payload as { invoiceId?: string; claimId?: string; to?: string };
    switch (event.eventType) {
      case "HospitalInvoiceIssued":
        return draftFor(String(p.invoiceId), event.facilityId, event.actorUserId);
      case "ClaimSubmitted":
        return closeBlocker(String(p.claimId), event.facilityId, event.actorUserId);
      case "ClaimStatusChanged":
        if (p.to === "REJECTED" || p.to === "CLOSED") return closeBlocker(String(p.claimId), event.facilityId, event.actorUserId);
    }
  },
};
