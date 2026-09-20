import { prisma } from "@/lib/db";
import { InvoiceStatus } from "@prisma/client";
import { patientLanguage as L } from "./language";
import { assertClass, type PatientAccessScope } from "../context";

/**
 * Phase D11 — patient-facing bills (brief §23). A read projection over the
 * HOSPITAL revenue cycle (Invoice/Payment), which is deliberately distinct from
 * the D3/D5 SaaS commercial billing an organization pays Aarogya. Amounts are
 * INR minor units in the canonical model; presented to the patient in whole
 * rupees. Only ISSUED/PARTIALLY_PAID/PAID invoices are shown — DRAFT internal
 * working documents and VOID invoices are never surfaced.
 */

const VISIBLE_STATUSES: InvoiceStatus[] = [InvoiceStatus.ISSUED, InvoiceStatus.PARTIALLY_PAID, InvoiceStatus.PAID];

export interface InvoiceDTO {
  id: string;
  invoiceNumber: string | null;
  statusLabel: string;
  status: string;
  totalMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  currency: string;
  issuedAt: string | null;
  dueAt: string | null;
  payable: boolean;
  lines: { description: string; quantity: number; amountMinor: number }[];
}

/** Canonical outstanding for one invoice: total minus what has been allocated. */
export function outstandingMinor(inv: { status: string; totalMinor: number; allocatedMinor: number }): number {
  if (inv.status === "PAID" || inv.status === "VOID" || inv.status === "DRAFT") return 0;
  return Math.max(0, inv.totalMinor - inv.allocatedMinor);
}

export async function listInvoices(scope: PatientAccessScope): Promise<InvoiceDTO[]> {
  assertClass(scope, "BILLING");
  const invoices = await prisma.invoice.findMany({
    where: { patientId: { in: scope.patientIds }, status: { in: VISIBLE_STATUSES } },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { lines: { select: { description: true, quantity: true, netAmountMinor: true } } },
  });
  return invoices.map((inv) => {
    const outstanding = outstandingMinor(inv);
    return {
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      statusLabel: L.invoiceStatus(inv.status),
      status: inv.status,
      totalMinor: inv.totalMinor,
      paidMinor: inv.allocatedMinor,
      outstandingMinor: outstanding,
      currency: inv.currency,
      issuedAt: inv.issuedAt?.toISOString() ?? null,
      dueAt: inv.dueAt?.toISOString() ?? null,
      // Only the patient acting on their OWN record may pay.
      payable: scope.isSelf && outstanding > 0,
      lines: inv.lines.map((l) => ({ description: l.description, quantity: l.quantity, amountMinor: l.netAmountMinor })),
    };
  });
}

/** Aggregate outstanding across all visible invoices — for the home dashboard. */
export async function billingSummary(scope: PatientAccessScope): Promise<{ outstandingMinor: number; currency: string; invoiceCount: number }> {
  const invoices = await listInvoices(scope);
  // Never sum across currencies; use the first currency seen (single-facility
  // patients are single-currency). If mixed, we report the dominant currency's total.
  const byCurrency = new Map<string, number>();
  for (const inv of invoices) byCurrency.set(inv.currency, (byCurrency.get(inv.currency) ?? 0) + inv.outstandingMinor);
  const [currency, total] = [...byCurrency.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["INR", 0];
  return { outstandingMinor: total, currency, invoiceCount: invoices.filter((i) => i.outstandingMinor > 0).length };
}
