import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { computePurchaseOrderTotals } from "@/lib/hospital/procurement/pricing";
import type { RfqStatus, SupplierInvoiceStatus, UnitOfMeasure } from "@prisma/client";

/**
 * Enterprise procurement depth (Phase B8) — RFQ + vendor comparison, effective
 * supplier pricing/contracts, and the supplier-invoice three-way-match
 * BOUNDARY. Builds on the Phase 6A requisition/PO/GR services (reused, not
 * rebuilt). Vendor selection is always an authorized human decision (never an
 * algorithm); the three-way match is documentary (NOT accounting); historical
 * PO/receipt prices are never rewritten when a contract price changes.
 */

// ── Supplier contracts / effective pricing ──────────────────────────────────
export async function createSupplierContract(input: { facilityId: string; supplierId: string; itemId: string; agreedPriceMinor: number; effectiveFrom?: Date; effectiveTo?: Date; moq?: number; leadTimeDays?: number; paymentTermsDays?: number; contractRef?: string; createdByStaffId: string; byUserId: string }) {
  if (input.agreedPriceMinor < 0) throw new BadRequestError("Price cannot be negative.");
  const supplier = await prisma.supplier.findUnique({ where: { id: input.supplierId } });
  if (!supplier || supplier.facilityId !== input.facilityId) throw new NotFoundError("Supplier not found in this facility.");
  const item = await prisma.item.findUnique({ where: { id: input.itemId } });
  if (!item || (item.facilityId && item.facilityId !== input.facilityId)) throw new NotFoundError("Item not found in this facility.");
  const contract = await prisma.supplierContract.create({
    data: { facilityId: input.facilityId, supplierId: input.supplierId, itemId: input.itemId, agreedPriceMinor: input.agreedPriceMinor, effectiveFrom: input.effectiveFrom ?? new Date(), effectiveTo: input.effectiveTo, moq: input.moq, leadTimeDays: input.leadTimeDays, paymentTermsDays: input.paymentTermsDays, contractRef: input.contractRef, createdByStaffId: input.createdByStaffId },
  });
  await recordAuditEvent("hospital.procurement.contractCreated", input.byUserId, { contractId: contract.id, supplierId: input.supplierId, itemId: input.itemId, agreedPriceMinor: input.agreedPriceMinor }, { facilityId: input.facilityId });
  return contract;
}

export async function deactivateSupplierContract(input: { contractId: string; facilityId: string; byUserId: string }) {
  const contract = await prisma.supplierContract.findUnique({ where: { id: input.contractId } });
  if (!contract || contract.facilityId !== input.facilityId) throw new NotFoundError("Contract not found.");
  const updated = await prisma.supplierContract.update({ where: { id: contract.id }, data: { active: false, effectiveTo: contract.effectiveTo ?? new Date() } });
  await recordAuditEvent("hospital.procurement.contractDeactivated", input.byUserId, { contractId: contract.id }, { facilityId: input.facilityId });
  return updated;
}

/** Current effective contract price for a supplier+item (documentary; future procurement reads this, never rewriting history). */
export async function getEffectivePrice(facilityId: string, supplierId: string, itemId: string) {
  const now = new Date();
  const contract = await prisma.supplierContract.findFirst({
    where: { facilityId, supplierId, itemId, active: true, effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
    orderBy: { effectiveFrom: "desc" },
  });
  return contract ? { agreedPriceMinor: contract.agreedPriceMinor, moq: contract.moq, leadTimeDays: contract.leadTimeDays, contractId: contract.id } : null;
}

// ── RFQ + quotations + vendor comparison ────────────────────────────────────
export async function createRfq(input: { facilityId: string; requisitionId?: string; validUntil?: Date; notes?: string; lines: { itemId: string; quantity: number; unit: UnitOfMeasure }[]; createdByStaffId: string; byUserId: string }) {
  if (input.lines.length === 0) throw new BadRequestError("An RFQ needs at least one line.");
  for (const l of input.lines) {
    const item = await prisma.item.findUnique({ where: { id: l.itemId } });
    if (!item || (item.facilityId && item.facilityId !== input.facilityId)) throw new NotFoundError(`Item ${l.itemId} not found in this facility.`);
    if (l.quantity <= 0) throw new BadRequestError("Line quantity must be positive.");
  }
  const rfq = await prisma.rfq.create({
    data: { facilityId: input.facilityId, requisitionId: input.requisitionId, validUntil: input.validUntil, notes: input.notes, createdByStaffId: input.createdByStaffId, lines: { create: input.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity, unit: l.unit })) } },
    include: { lines: true },
  });
  await recordAuditEvent("hospital.procurement.rfqCreated", input.byUserId, { rfqId: rfq.id, lines: rfq.lines.length }, { facilityId: input.facilityId });
  return rfq;
}

const RFQ_TRANSITIONS: Record<RfqStatus, RfqStatus[]> = {
  DRAFT: ["SENT", "CANCELLED"],
  SENT: ["CLOSED", "CANCELLED"],
  CLOSED: [],
  CANCELLED: [],
};
export async function transitionRfq(input: { rfqId: string; facilityId: string; to: RfqStatus; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const rfq = await tx.rfq.findUnique({ where: { id: input.rfqId } });
    if (!rfq || rfq.facilityId !== input.facilityId) throw new NotFoundError("RFQ not found.");
    if (!(RFQ_TRANSITIONS[rfq.status]?.includes(input.to) ?? false)) throw new BadRequestError(`Illegal RFQ transition ${rfq.status} -> ${input.to}.`);
    const r = await tx.rfq.updateMany({ where: { id: rfq.id, status: rfq.status }, data: { status: input.to } });
    if (r.count !== 1) throw new BadRequestError("RFQ changed state concurrently — refresh and try again.");
    await tx.auditEvent.create({ data: { type: "hospital.procurement.rfqUpdated", userId: input.byUserId, detail: { rfqId: rfq.id, from: rfq.status, to: input.to }, facilityId: rfq.facilityId } });
    return tx.rfq.findUniqueOrThrow({ where: { id: rfq.id } });
  });
}

/** Record a supplier's quotation against an RFQ. Server-computes totals (never trusted from the client). Unique per (rfq, supplier). */
export async function recordQuotation(input: { rfqId: string; facilityId: string; supplierId: string; deliveryDays?: number; validUntil?: Date; notes?: string; lines: { itemId: string; unitPriceMinor: number; taxPercent?: number; quantity: number }[]; recordedByStaffId: string; byUserId: string }) {
  const rfq = await prisma.rfq.findUnique({ where: { id: input.rfqId } });
  if (!rfq || rfq.facilityId !== input.facilityId) throw new NotFoundError("RFQ not found.");
  const supplier = await prisma.supplier.findUnique({ where: { id: input.supplierId } });
  if (!supplier || supplier.facilityId !== input.facilityId) throw new NotFoundError("Supplier not found in this facility.");
  if (input.lines.length === 0) throw new BadRequestError("A quotation needs at least one line.");

  const totals = computePurchaseOrderTotals(input.lines.map((l) => ({ orderedQuantity: l.quantity, unitPriceMinor: l.unitPriceMinor, taxPercent: l.taxPercent ?? 0 })));
  const quotation = await prisma.rfqQuotation.create({
    data: {
      rfqId: input.rfqId, facilityId: input.facilityId, supplierId: input.supplierId, deliveryDays: input.deliveryDays, validUntil: input.validUntil, notes: input.notes,
      status: "SUBMITTED", subtotalMinor: totals.subtotalMinor, taxMinor: totals.taxMinor, totalMinor: totals.totalMinor, recordedByStaffId: input.recordedByStaffId,
      lines: { create: input.lines.map((l) => ({ itemId: l.itemId, unitPriceMinor: l.unitPriceMinor, taxPercent: l.taxPercent ?? 0, lineTotalMinor: Math.round(l.quantity * l.unitPriceMinor * (1 + (l.taxPercent ?? 0) / 100)) })) },
    },
    include: { lines: true },
  }).catch((e: unknown) => {
    if (e instanceof Error && /unique/i.test(e.message)) throw new BadRequestError("A quotation from this supplier already exists for this RFQ.");
    throw e;
  });
  await recordAuditEvent("hospital.procurement.quotationRecorded", input.byUserId, { quotationId: quotation.id, rfqId: input.rfqId, supplierId: input.supplierId, totalMinor: totals.totalMinor }, { facilityId: input.facilityId });
  return quotation;
}

/** Vendor comparison view — quotations for an RFQ, cheapest-total first (display only; selection remains a human action). */
export async function compareQuotations(rfqId: string, facilityId: string) {
  const rfq = await prisma.rfq.findUnique({ where: { id: rfqId } });
  if (!rfq || rfq.facilityId !== facilityId) throw new NotFoundError("RFQ not found.");
  const quotations = await prisma.rfqQuotation.findMany({ where: { rfqId, facilityId }, include: { supplier: { select: { id: true, name: true, code: true } }, lines: true }, orderBy: { totalMinor: "asc" } });
  return { rfq, quotations };
}

/** Explicit, authorized supplier selection (single-winner: exactly one SELECTED quotation per RFQ). */
export async function selectQuotation(input: { quotationId: string; facilityId: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const quotation = await tx.rfqQuotation.findUnique({ where: { id: input.quotationId } });
    if (!quotation || quotation.facilityId !== input.facilityId) throw new NotFoundError("Quotation not found.");
    // Serialize the whole award decision on the parent RFQ row BEFORE touching
    // any quotation. Without this, two concurrent awards on the same RFQ each
    // lock their own quotation first and then reach for the other's in the
    // losing-bid sweep below — a circular wait that PostgreSQL breaks by killing
    // one transaction with deadlock_detected (40P01). Locking the parent first
    // makes both transactions contend on the SAME row in the SAME order, so the
    // loser blocks and then fails cleanly on the guarded update below rather
    // than deadlocking. Verified by scripts/verify-postgres-phase-b-final.ts.
    await tx.rfq.updateMany({ where: { id: quotation.rfqId, facilityId: input.facilityId }, data: { updatedAt: new Date() } });
    const r = await tx.rfqQuotation.updateMany({ where: { id: quotation.id, status: "SUBMITTED", selected: false }, data: { status: "SELECTED", selected: true } });
    if (r.count !== 1) throw new BadRequestError("Quotation is not selectable (already decided).");
    // Mark the other submitted quotations for this RFQ as rejected (losing bids).
    await tx.rfqQuotation.updateMany({ where: { rfqId: quotation.rfqId, id: { not: quotation.id }, status: "SUBMITTED" }, data: { status: "REJECTED" } });
    await tx.auditEvent.create({ data: { type: "hospital.procurement.supplierSelected", userId: input.byUserId, detail: { quotationId: quotation.id, rfqId: quotation.rfqId, supplierId: quotation.supplierId }, facilityId: quotation.facilityId } });
    return tx.rfqQuotation.findUniqueOrThrow({ where: { id: quotation.id } });
  });
}

// ── Supplier invoice — three-way-match BOUNDARY (PO / GR / Invoice) ──────────
export async function recordSupplierInvoice(input: { facilityId: string; supplierId: string; invoiceRef: string; totalMinor: number; purchaseOrderId?: string; invoiceDate?: Date; recordedByStaffId: string; notes?: string; byUserId: string }) {
  const supplier = await prisma.supplier.findUnique({ where: { id: input.supplierId } });
  if (!supplier || supplier.facilityId !== input.facilityId) throw new NotFoundError("Supplier not found in this facility.");

  // Three-way match vs the PO + its accepted goods receipts (documentary).
  let quantityMismatch = false, priceMismatch = false, missingReceipt = false, matchNotes = "No PO linked.";
  if (input.purchaseOrderId) {
    const po = await prisma.purchaseOrder.findUnique({ where: { id: input.purchaseOrderId }, include: { lines: true, goodsReceipts: { where: { status: "APPROVED" }, include: { lines: true } } } });
    if (!po || po.facilityId !== input.facilityId) throw new NotFoundError("Purchase order not found in this facility.");
    priceMismatch = input.totalMinor !== po.totalMinor;
    const orderedQty = po.lines.reduce((s, l) => s + l.orderedQuantity, 0);
    const acceptedQty = po.goodsReceipts.flatMap((g) => g.lines).reduce((s, l) => s + l.acceptedQuantity, 0);
    missingReceipt = acceptedQty === 0;
    quantityMismatch = acceptedQty !== orderedQty;
    matchNotes = `PO total ${po.totalMinor}, invoice ${input.totalMinor}; ordered ${orderedQty}, accepted ${acceptedQty}.`;
  }
  const status: SupplierInvoiceStatus = input.purchaseOrderId ? (quantityMismatch || priceMismatch || missingReceipt ? "DISCREPANCY" : "MATCHED") : "RECEIVED";

  const invoice = await prisma.supplierInvoice.create({
    data: { facilityId: input.facilityId, supplierId: input.supplierId, purchaseOrderId: input.purchaseOrderId, invoiceRef: input.invoiceRef, invoiceDate: input.invoiceDate, totalMinor: input.totalMinor, status, quantityMismatch, priceMismatch, missingReceipt, matchNotes, recordedByStaffId: input.recordedByStaffId, notes: input.notes } as never,
  }).catch((e: unknown) => {
    if (e instanceof Error && /unique/i.test(e.message)) throw new BadRequestError("A supplier invoice with that reference already exists (duplicate invoice reference).");
    throw e;
  });
  await recordAuditEvent("hospital.procurement.invoiceRecorded", input.byUserId, { invoiceId: invoice.id, status, quantityMismatch, priceMismatch, missingReceipt }, { facilityId: input.facilityId });
  return invoice;
}

export async function reviewSupplierInvoice(input: { invoiceId: string; facilityId: string; to: "APPROVED" | "REJECTED"; reviewedByStaffId: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const invoice = await tx.supplierInvoice.findUnique({ where: { id: input.invoiceId } });
    if (!invoice || invoice.facilityId !== input.facilityId) throw new NotFoundError("Invoice not found.");
    if (invoice.status === "APPROVED" || invoice.status === "REJECTED") throw new BadRequestError(`Invoice is already ${invoice.status}.`);
    const r = await tx.supplierInvoice.updateMany({ where: { id: invoice.id, status: invoice.status }, data: { status: input.to, reviewedByStaffId: input.reviewedByStaffId, reviewedAt: new Date() } });
    if (r.count !== 1) throw new BadRequestError("Invoice changed state concurrently — refresh and try again.");
    await tx.auditEvent.create({ data: { type: "hospital.procurement.invoiceReviewed", userId: input.byUserId, detail: { invoiceId: invoice.id, to: input.to }, facilityId: invoice.facilityId } });
    return tx.supplierInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
  });
}

// ── Supplier performance (DERIVED from procurement transactions) ─────────────
export async function getSupplierPerformance(facilityId: string) {
  const suppliers = await prisma.supplier.findMany({ where: { facilityId }, select: { id: true, name: true, code: true } });
  const out = [];
  for (const s of suppliers) {
    const [poCount, receipts] = await Promise.all([
      prisma.purchaseOrder.count({ where: { facilityId, supplierId: s.id } }),
      prisma.goodsReceiptLine.findMany({ where: { goodsReceipt: { facilityId, purchaseOrder: { supplierId: s.id }, status: "APPROVED" } }, select: { acceptedQuantity: true, rejectedQuantity: true } }),
    ]);
    const accepted = receipts.reduce((a, r) => a + r.acceptedQuantity, 0);
    const rejected = receipts.reduce((a, r) => a + r.rejectedQuantity, 0);
    const totalReceived = accepted + rejected;
    out.push({ supplierId: s.id, name: s.name, code: s.code, purchaseOrders: poCount, receivedLines: receipts.length, acceptedQty: accepted, rejectedQty: rejected, rejectionRate: totalReceived > 0 ? Math.round((rejected / totalReceived) * 1000) / 10 : 0 });
  }
  return out;
}
