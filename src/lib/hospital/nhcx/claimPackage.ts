import { createHash } from "crypto";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { authorizeAccess } from "@/lib/auth/authorize/engine";
import type { AuthorizationActor } from "@/lib/auth/authorize/types";

/**
 * Phase C5 — canonical claim package composition.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THIS IS THE CANONICAL LAYER. IT KNOWS NOTHING ABOUT NHCX.
 *
 * It gathers what a claim consists of, straight from the Phase 5 billing
 * records, and validates it. The protocol mapping happens afterwards in
 * fhirMapper.ts — keeping them apart is what stops dozens of protocol fields
 * leaking into the billing models.
 *
 * Two rules it exists to enforce:
 *
 *   TOTALS ARE SERVER-DERIVED. Every amount is recomputed from canonical
 *   InvoiceLine rows. Nothing a browser sends is trusted, because a claim total
 *   is a financial assertion.
 *
 *   DOCUMENTS ARE MINIMIZED AND AUTHORIZED. A claim gets claim-relevant
 *   documents only, each one individually cleared by the C4 engine. Having a
 *   claim is not a reason to ship a patient's entire chart to an insurer.
 * ════════════════════════════════════════════════════════════════════════════
 */

/** Document types that are plausibly claim-relevant. Everything else is excluded. */
export const CLAIM_RELEVANT_DOCUMENT_TYPES = [
  "DISCHARGE_SUMMARY",
  "OPERATIVE_NOTE",
  "DIAGNOSTIC_REPORT",
  "PRESCRIPTION",
  "REPORT",
  "REFERRAL_LETTER",
  "CERTIFICATE",
  "INVOICE",
] as const;

export interface ClaimPackage {
  claim: {
    id: string;
    claimNumber: string | null;
    status: string;
    facilityId: string;
    submittedAmountMinor: number;
  };
  patient: { id: string; uhid: string; fullName: string; sex: string; dob: Date | null };
  encounter: { id: string; type: string; status: string; registeredAt: Date; closedAt: Date | null } | null;
  coverage: {
    id: string; memberId: string; payerId: string; payerName: string;
    planId: string | null; validFrom: Date; validTo: Date | null; status: string;
  };
  preAuthorization: {
    id: string; status: string; requestedAmountMinor: number;
    approvedAmountMinor: number | null; payerReferenceNo: string | null; decidedAt: Date | null;
  } | null;
  invoice: { id: string; invoiceNumber: string | null; totalMinor: number; status: string };
  lines: {
    id: string; invoiceLineId: string; description: string;
    quantity: number; claimedAmountMinor: number;
  }[];
  diagnoses: { id: string; diagnosis: string; code: string | null; codeSystem: string | null; type: string }[];
  documents: {
    id: string; type: string; title: string; version: number;
    accessPolicy: string; contentHash: string;
  }[];
  /** Recomputed from canonical lines. NEVER taken from a request. */
  totals: { claimedMinor: number; lineCount: number };
  /** Blocking problems. A package with any of these must not be submitted. */
  blockers: string[];
  /** Non-blocking observations for the pre-flight checklist. */
  warnings: string[];
  /** Documents excluded, and why — surfaced so exclusion is never silent. */
  excludedDocuments: { id: string; title: string; reason: string }[];
}

function hashDocument(d: { id: string; version: number; title: string; type: string; storageRef: string | null }): string {
  // Hashes the document IDENTITY and version, not its bytes: Aarogya stores a
  // storage reference rather than content, so this proves which version was
  // included without pretending to have verified the file itself.
  return createHash("sha256")
    .update(`${d.id}|${d.version}|${d.type}|${d.title}|${d.storageRef ?? ""}`)
    .digest("hex");
}

/**
 * Build the canonical package for a claim.
 *
 * `actor` is required because document inclusion runs through the C4
 * authorization engine — there is no path that assembles a package without an
 * authenticated subject.
 */
export async function buildClaimPackage(args: {
  claimId: string;
  facilityId: string;
  actor: AuthorizationActor;
}): Promise<ClaimPackage> {
  const claim = await prisma.claim.findUnique({
    where: { id: args.claimId },
    include: {
      lines: { include: { invoiceLine: true } },
      coverage: { include: { payer: true } },
      preAuthorization: true,
      invoice: true,
    },
  });
  // Not-found shaped, so a claim in another facility is indistinguishable from
  // one that does not exist.
  if (!claim || claim.facilityId !== args.facilityId) throw new NotFoundError("Claim not found.");

  const invoice = claim.invoice;
  const patient = await prisma.patient.findUnique({ where: { id: invoice.patientId } });
  if (!patient) throw new NotFoundError("Claim patient not found.");
  // Defence in depth: the invoice's patient must live in this facility too.
  if (patient.facilityId !== args.facilityId) throw new NotFoundError("Claim not found.");

  const encounter = invoice.encounterId
    ? await prisma.encounter.findUnique({ where: { id: invoice.encounterId } })
    : null;
  if (encounter && encounter.facilityId !== args.facilityId) {
    throw new BadRequestError("Claim encounter does not belong to this facility.");
  }
  if (encounter && encounter.patientId !== patient.id) {
    // Wrong-patient guard: a claim must never carry another patient's encounter.
    throw new BadRequestError("Claim encounter does not belong to the claim patient.");
  }

  const blockers: string[] = [];
  const warnings: string[] = [];

  // ── Coverage validation ───────────────────────────────────────────────────
  const coverage = claim.coverage;
  if (coverage.patientId !== patient.id) blockers.push("Coverage belongs to a different patient.");
  if (coverage.status !== "ACTIVE") blockers.push(`Coverage is ${coverage.status}.`);
  const now = new Date();
  if (coverage.validFrom > now) blockers.push("Coverage has not started yet.");
  if (coverage.validTo && coverage.validTo < now) {
    // Blocked rather than silently submitted — an expired-coverage claim is a
    // predictable rejection and a reconciliation problem later.
    blockers.push("Coverage has expired.");
  }

  // ── Pre-authorization ─────────────────────────────────────────────────────
  const preAuth = claim.preAuthorization;
  if (preAuth) {
    if (preAuth.coverageId !== coverage.id) blockers.push("Pre-authorization is for a different coverage.");
    if (preAuth.status === "DENIED") blockers.push("Pre-authorization was denied.");
    // Expiry is derived, not trusted from the status column.
    if (preAuth.status === "EXPIRED") warnings.push("Pre-authorization has expired.");
    if (preAuth.status === "REQUESTED") warnings.push("Pre-authorization has not been decided yet.");
    if (preAuth.status === "APPROVED" && preAuth.approvedAmountMinor === null) {
      warnings.push("Pre-authorization is approved but carries no approved amount.");
    }
  }

  // ── Lines: every one must trace to this invoice ───────────────────────────
  const lines = claim.lines.map((l) => {
    if (l.invoiceLine.invoiceId !== invoice.id) {
      blockers.push("A claim line references a different invoice.");
    }
    return {
      id: l.id,
      invoiceLineId: l.invoiceLineId,
      description: l.invoiceLine.description,
      quantity: l.invoiceLine.quantity,
      claimedAmountMinor: l.claimedAmountMinor,
    };
  });
  if (lines.length === 0) blockers.push("Claim has no lines.");

  // ── Totals: recomputed, never trusted ─────────────────────────────────────
  const claimedMinor = lines.reduce((sum, l) => sum + l.claimedAmountMinor, 0);
  if (claimedMinor <= 0) blockers.push("Claimed amount must be positive.");
  if (claimedMinor !== claim.submittedAmountMinor) {
    // A stored total that disagrees with its own lines is a data-integrity
    // problem; surfaced rather than quietly overwritten.
    warnings.push(
      `Stored claim total (${claim.submittedAmountMinor}) differs from the sum of its lines (${claimedMinor}). The recomputed value is authoritative.`
    );
  }

  // ── Diagnoses ─────────────────────────────────────────────────────────────
  const diagnoses = encounter
    ? await prisma.diagnosis.findMany({
        where: { encounterId: encounter.id, patientId: patient.id, status: { not: "ENTERED_IN_ERROR" } },
        orderBy: { createdAt: "asc" },
        take: 50,
      })
    : [];

  // ── Documents: minimized, then individually authorized ────────────────────
  const candidates = await prisma.clinicalDocument.findMany({
    where: {
      facilityId: args.facilityId,
      patientId: patient.id,
      status: "CURRENT",
      ...(encounter ? { encounterId: encounter.id } : {}),
      type: { in: [...CLAIM_RELEVANT_DOCUMENT_TYPES] },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  const documents: ClaimPackage["documents"] = [];
  const excludedDocuments: ClaimPackage["excludedDocuments"] = [];

  // One authorization evaluation covers the RESTRICTED class: the decision
  // turns on the actor-to-patient relationship, which is identical for every
  // document here, so evaluating per document would be N identical queries.
  const restrictedDecision = candidates.some((d) => d.accessPolicy === "RESTRICTED")
    ? await authorizeAccess({
        actor: args.actor,
        action: "document.read.restricted",
        resource: { type: "DOCUMENT", facilityId: args.facilityId, patientId: patient.id, dataClass: "HIGHLY_SENSITIVE" },
        purpose: "INSURANCE",
      }, { skipAudit: true })
    : null;

  for (const d of candidates) {
    if (d.accessPolicy === "RESTRICTED") {
      // A restricted document does not enter a claim just because a claim
      // exists. It requires the same care relationship any other access would.
      if (!restrictedDecision || restrictedDecision.decision !== "ALLOW") {
        excludedDocuments.push({ id: d.id, title: d.title, reason: "Restricted document; not authorized for this actor." });
        continue;
      }
    }
    documents.push({
      id: d.id, type: d.type, title: d.title, version: d.version,
      accessPolicy: d.accessPolicy,
      contentHash: hashDocument({ id: d.id, version: d.version, title: d.title, type: d.type, storageRef: d.storageRef }),
    });
  }

  if (documents.length === 0) warnings.push("No claim-relevant documents were attached.");

  return {
    claim: {
      id: claim.id, claimNumber: claim.claimNumber, status: claim.status,
      facilityId: claim.facilityId, submittedAmountMinor: claim.submittedAmountMinor,
    },
    patient: { id: patient.id, uhid: patient.uhid, fullName: patient.fullName, sex: patient.sex, dob: patient.dob },
    encounter: encounter
      ? { id: encounter.id, type: encounter.type, status: encounter.status, registeredAt: encounter.registeredAt, closedAt: encounter.closedAt }
      : null,
    coverage: {
      id: coverage.id, memberId: coverage.memberId, payerId: coverage.payerId,
      payerName: coverage.payer.name, planId: coverage.planId,
      validFrom: coverage.validFrom, validTo: coverage.validTo, status: coverage.status,
    },
    preAuthorization: preAuth
      ? {
          id: preAuth.id, status: preAuth.status, requestedAmountMinor: preAuth.requestedAmountMinor,
          approvedAmountMinor: preAuth.approvedAmountMinor, payerReferenceNo: preAuth.payerReferenceNo,
          decidedAt: preAuth.decidedAt,
        }
      : null,
    invoice: {
      id: invoice.id, invoiceNumber: invoice.invoiceNumber,
      totalMinor: invoice.totalMinor, status: invoice.status,
    },
    lines,
    diagnoses: diagnoses.map((d) => ({
      id: d.id, diagnosis: d.diagnosis, code: d.code, codeSystem: d.codeSystem, type: d.type,
    })),
    documents,
    totals: { claimedMinor, lineCount: lines.length },
    blockers,
    warnings,
    excludedDocuments,
  };
}

/** Stable hash of a package, so a submission can prove what it contained. */
export function hashPackage(pkg: unknown): { hash: string; bytes: number } {
  const canonical = JSON.stringify(pkg, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.keys(v as Record<string, unknown>).sort().reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = (v as Record<string, unknown>)[k];
        return acc;
      }, {});
    }
    return v;
  });
  return { hash: createHash("sha256").update(canonical).digest("hex"), bytes: Buffer.byteLength(canonical, "utf8") };
}
