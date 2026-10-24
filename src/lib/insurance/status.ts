import type { Claim, Invoice, PreAuthorization } from "@prisma/client";
import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/auth/rbac";
import { personAccess, ownedPersonId } from "@/lib/person/access";
import { resolvePatientIdsForRead } from "@/lib/patient/merge";
import { activeLinkedPatients } from "@/lib/sharing/shares";

/**
 * Week 5c — what the patient sees of their insurance and bills
 * (docs/PATIENT_INSURANCE_DESIGN.md §5): canonical values only, in plain
 * words, never a prediction. For each visit at each hospital: the
 * pre-authorization, cashless at discharge, the itemised bill, the
 * patient's share, and the claim from submitted to settled, with the
 * documents the hospital asked for. The member themselves, or a household
 * proxy with INSURANCE; through personAccess.
 *
 * The patient's share is computed only here, from the invoice and the
 * insurer's decided values:
 *   self-pay (no claim, no pre-authorization,
 *     no active coverage at the facility)  the invoice total;
 *   claim approved / partly / settled     total minus the insurer's amount;
 *   claim rejected                        the total;
 *   cashless approved (pre-auth APPROVED,
 *     no claim decision yet)              total minus the approved amount,
 *                                         labelled "until the claim is decided";
 *   anything else                         "not yet known".
 * Less what the patient (not the insurer) has already paid against it.
 */
const VISIBLE = ["ISSUED", "PARTIALLY_PAID", "PAID"] as const;
const DECIDED = ["APPROVED", "PARTIALLY_APPROVED", "SETTLED", "CLOSED"];

export const PREAUTH_TEXT: Record<string, string> = {
  REQUESTED: "The hospital has asked your insurer to approve the treatment",
  APPROVED: "Your insurer approved the treatment",
  DENIED: "Your insurer did not approve the treatment",
  EXPIRED: "The approval request expired",
};
export const CLAIM_STEPS = [
  { key: "SUBMITTED", label: "Sent to your insurer" },
  { key: "UNDER_REVIEW", label: "Your insurer is reviewing it" },
  { key: "DECIDED", label: "Your insurer decided" },
  { key: "SETTLED", label: "Your insurer paid the hospital" },
] as const;
const CLAIM_TEXT: Record<string, string> = {
  DRAFT: "The hospital is preparing your claim",
  SUBMITTED: "The claim was sent to your insurer",
  UNDER_REVIEW: "Your insurer is reviewing the claim",
  APPROVED: "Your insurer approved the claim",
  PARTIALLY_APPROVED: "Your insurer approved part of the claim",
  REJECTED: "Your insurer rejected the claim",
  SETTLED: "Your insurer has paid the hospital",
  CLOSED: "The claim is closed",
};

/** Whose: the caller's own Person, or a member they hold INSURANCE for. */
export async function insurancePerson(a: { userId: string; memberPersonId?: string }): Promise<string> {
  if (a.memberPersonId) {
    const g = await personAccess({ kind: "PROXY", userId: a.userId, permission: "INSURANCE" }, a.memberPersonId, "INSURANCE");
    if (!g?.proxy) throw new NotFoundError();
    return a.memberPersonId;
  }
  const personId = await ownedPersonId(a.userId);
  if (!personId || !(await personAccess({ kind: "OWNER", userId: a.userId }, personId, "INSURANCE"))) throw new NotFoundError();
  return personId;
}

export async function personPatientIds(personId: string): Promise<string[]> {
  const links = await activeLinkedPatients(personId);
  return [...new Set((await Promise.all(links.map((p) => resolvePatientIdsForRead(p)))).flat())];
}

export interface ShareResult { known: boolean; insurerMinor: number | null; shareMinor: number | null; paidByYouMinor: number; dueMinor: number; basis: "SELF_PAY" | "CLAIM" | "CLAIM_REJECTED" | "CASHLESS_APPROVAL" | "UNKNOWN"; text: string }

/** The patient's share of one invoice, from decided values only (see above). Exported for the payment path. */
export function patientShare(inv: Pick<Invoice, "status" | "totalMinor">, insured: boolean, claim: Pick<Claim, "status" | "approvedAmountMinor" | "settledAmountMinor"> | null, preAuth: Pick<PreAuthorization, "status" | "approvedAmountMinor"> | null, paidByYouMinor: number): ShareResult {
  const unknown = (text: string): ShareResult => ({ known: false, insurerMinor: null, shareMinor: null, paidByYouMinor, dueMinor: 0, basis: "UNKNOWN", text });
  if (!(VISIBLE as readonly string[]).includes(inv.status)) return unknown("Not yet known: the bill isn't final.");
  const done = (basis: ShareResult["basis"], insurer: number, text: string): ShareResult => {
    const share = Math.max(0, inv.totalMinor - insurer);
    return { known: true, insurerMinor: insurer, shareMinor: share, paidByYouMinor, dueMinor: Math.max(0, share - paidByYouMinor), basis, text };
  };
  if (!insured) return done("SELF_PAY", 0, "You pay this bill yourself.");
  if (claim && DECIDED.includes(claim.status) && typeof (claim.settledAmountMinor ?? claim.approvedAmountMinor) === "number") {
    return done("CLAIM", Math.min(inv.totalMinor, (claim.settledAmountMinor ?? claim.approvedAmountMinor)!), "Your share, after your insurer's decision.");
  }
  if (claim?.status === "REJECTED") return done("CLAIM_REJECTED", 0, "Your insurer rejected the claim: the whole bill is yours to pay. Ask the hospital's insurance desk if you think this is wrong.");
  if (preAuth?.status === "APPROVED" && typeof preAuth.approvedAmountMinor === "number") {
    return done("CASHLESS_APPROVAL", Math.min(inv.totalMinor, preAuth.approvedAmountMinor), "Your share, from your insurer's cashless approval. It is final once the claim is decided.");
  }
  return unknown("Not yet known: waiting for your insurer's decision.");
}

/**
 * Is this bill an insured one? A claim, a pre-authorization for the visit, an
 * insurer on the invoice, or any ACTIVE coverage at the facility when it was
 * issued: then the share waits for the insurer rather than showing the total.
 */
export async function invoiceInsured(inv: Pick<Invoice, "patientId" | "issuedAt" | "payerId">, payerIsCash: boolean, hasClaim: boolean, hasPreAuth: boolean): Promise<boolean> {
  if (hasClaim || hasPreAuth || (inv.payerId && !payerIsCash)) return true;
  const at = inv.issuedAt ?? new Date();
  return (await prisma.patientCoverage.count({ where: { patientId: inv.patientId, status: "ACTIVE", validFrom: { lte: at }, OR: [{ validTo: null }, { validTo: { gte: at } }] } })) > 0;
}

/** What the patient paid themselves towards an invoice (not the insurer's settlement). */
async function paidByPatient(invoiceId: string): Promise<number> {
  const rows = await prisma.paymentAllocation.findMany({ where: { invoiceId, payment: { method: { not: "INSURANCE_SETTLEMENT" }, status: "RECEIVED" } }, select: { amountMinor: true } });
  return rows.reduce((s, r) => s + r.amountMinor, 0);
}

export async function insuranceStatus(a: { userId: string; memberPersonId?: string }) {
  const personId = await insurancePerson(a);
  const patientIds = await personPatientIds(personId);
  const encounters = await prisma.encounter.findMany({
    where: { patientId: { in: patientIds }, OR: [{ invoices: { some: { status: { in: [...VISIBLE] } } } }, { preAuthorizations: { some: {} } }] },
    orderBy: { registeredAt: "desc" }, take: 20,
    select: {
      id: true, type: true, registeredAt: true, facility: { select: { id: true, name: true } },
      admission: { select: { admittedAt: true, discharge: { select: { dischargedAt: true, initiatedAt: true } } } },
      preAuthorizations: { orderBy: { requestedAt: "desc" }, select: { id: true, status: true, approvedAmountMinor: true, requestedAt: true, decidedAt: true, coverage: { select: { payer: { select: { name: true } } } } } },
      invoices: {
        where: { status: { in: [...VISIBLE] } }, orderBy: { createdAt: "asc" },
        include: { lines: { select: { description: true, quantity: true, netAmountMinor: true } }, payer: { select: { name: true, type: true } }, claim: true },
      },
    },
  });
  const requests = await prisma.claimDocumentRequest.findMany({ where: { patientId: { in: patientIds } }, orderBy: { createdAt: "desc" }, take: 50 });
  const visits = [];
  for (const e of encounters) {
    const preAuth = e.preAuthorizations[0] ?? null;
    const discharged = e.admission?.discharge ?? null;
    const bills = [];
    for (const inv of e.invoices) {
      const paid = await paidByPatient(inv.id);
      const insured = await invoiceInsured(inv, inv.payer?.type === "CASH", !!inv.claim, !!preAuth);
      const share = patientShare(inv, insured, inv.claim, preAuth, paid);
      bills.push({
        invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, statusLabel: inv.status === "PAID" ? "Paid" : inv.status === "PARTIALLY_PAID" ? "Partly paid" : "To pay", currency: inv.currency,
        totalMinor: inv.totalMinor, payer: inv.payer && inv.payer.type !== "CASH" ? inv.payer.name : "You (self-pay)",
        lines: inv.lines.map((l) => ({ description: l.description, quantity: l.quantity, amountMinor: l.netAmountMinor })),
        share, payable: share.known && share.dueMinor > 0,
        claim: inv.claim ? claimView(inv.claim) : null,
        documentRequests: requests.filter((r) => r.claimId === inv.claim?.id).map((r) => ({ id: r.id, description: r.description, status: r.status, createdAt: r.createdAt.toISOString() })),
      });
    }
    visits.push({
      encounterId: e.id, facility: e.facility.name, kind: e.admission ? "ADMISSION" : "VISIT", at: (e.admission?.admittedAt ?? e.registeredAt).toISOString(),
      preAuth: preAuth ? { status: preAuth.status, text: PREAUTH_TEXT[preAuth.status], insurer: preAuth.coverage.payer.name, approvedAmountMinor: preAuth.status === "APPROVED" ? preAuth.approvedAmountMinor : null, requestedAt: preAuth.requestedAt.toISOString(), decidedAt: preAuth.decidedAt?.toISOString() ?? null } : null,
      cashless: e.admission ? cashlessView(preAuth, !!discharged, e.invoices[0]?.claim ?? null) : null,
      discharge: discharged ? { initiatedAt: discharged.initiatedAt.toISOString(), dischargedAt: discharged.dischargedAt?.toISOString() ?? null } : null,
      bills,
    });
  }
  return { visits };
}

function claimView(c: Claim) {
  const reached = (k: string) => {
    if (k === "SUBMITTED") return !!c.submittedAt;
    if (k === "UNDER_REVIEW") return ["UNDER_REVIEW", "APPROVED", "PARTIALLY_APPROVED", "REJECTED", "SETTLED", "CLOSED"].includes(c.status);
    if (k === "DECIDED") return ["APPROVED", "PARTIALLY_APPROVED", "REJECTED", "SETTLED", "CLOSED"].includes(c.status) && !!c.decidedAt;
    return c.status === "SETTLED" || (c.status === "CLOSED" && !!c.settledAt);
  };
  return {
    claimNumber: c.claimNumber, status: c.status, text: CLAIM_TEXT[c.status],
    steps: CLAIM_STEPS.map((s) => ({ key: s.key, label: s.label, done: reached(s.key) })),
    approvedAmountMinor: ["APPROVED", "PARTIALLY_APPROVED", "SETTLED", "CLOSED"].includes(c.status) ? c.approvedAmountMinor : null,
    settledAmountMinor: c.settledAmountMinor, settledAt: c.settledAt?.toISOString() ?? null, rejected: c.status === "REJECTED" ? true : undefined,
  };
}

function cashlessView(preAuth: { status: string; approvedAmountMinor: number | null } | null, discharged: boolean, claim: Claim | null) {
  if (!preAuth) return { stage: "NONE", text: "No cashless request: the bill is yours, or the hospital will claim it later." };
  if (preAuth.status === "APPROVED") return { stage: "APPROVED", text: discharged ? "Cashless approved: your insurer pays the hospital up to the approved amount" : "Cashless approved so far; the final amount is decided at discharge", approvedUptoMinor: preAuth.approvedAmountMinor, claimed: !!claim };
  if (preAuth.status === "DENIED") return { stage: "DENIED", text: "Cashless wasn't approved: ask the hospital's insurance desk about paying and claiming later" };
  return { stage: "WAITING", text: discharged ? "Waiting for your insurer's final approval" : "Waiting for your insurer's approval" };
}
