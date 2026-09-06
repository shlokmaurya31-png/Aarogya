"use client";

import { useEffect, useState, useCallback } from "react";
import { BarChart3 } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { minorToRupees } from "@/lib/hospital/billing/money";

interface ReconciliationData {
  collectionByMethod: { method: string; grossMinor: number; refundedMinor: number; netMinor: number }[];
  outstandingByPayer: { payerId: string; payerName: string; outstandingMinor: number }[];
  chargeInvoiceCollectionLeakage: { grossChargesMinor: number; invoicedMinor: number; collectedMinor: number };
  claimAging: { countByAgeBucket: Record<string, number>; amountMinorByAgeBucket: Record<string, number>; countByStatus: Record<string, number> };
}

function money(minor: number) {
  return `₹${minorToRupees(minor).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
}

function defaultRange() {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export function BillingReconciliation() {
  const [range] = useState(defaultRange());
  const [data, setData] = useState<ReconciliationData | null>(null);

  const load = useCallback(() => {
    const params = new URLSearchParams({ dateFrom: range.from, dateTo: range.to });
    fetch(`/api/hospital/billing/reconciliation?${params}`).then((r) => r.json()).then(setData);
  }, [range]);
  useEffect(load, [load]);

  if (!data) return <div className="mx-auto max-w-5xl animate-pulse"><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex items-center gap-2"><BarChart3 size={18} className="text-cyan" /><h1 className="text-[20px] font-semibold tracking-tight">Reconciliation</h1></div>
      <p className="mt-1 text-[13px] text-text-secondary">{range.from} to {range.to} — every number derived live from immutable financial records, nothing pre-computed or stored.</p>

      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card className="rounded-[20px]">
          <CardLabel>Collection by method</CardLabel>
          <div className="mt-3 space-y-1.5 text-[12px]">
            {data.collectionByMethod.map((row) => (
              <div key={row.method} className="flex justify-between">
                <span>{row.method}</span>
                <span className="tabular-nums">{money(row.netMinor)} {row.refundedMinor > 0 && <span className="text-red-500">(−{money(row.refundedMinor)} refunded)</span>}</span>
              </div>
            ))}
            {data.collectionByMethod.length === 0 && <p className="text-text-tertiary">No payments in range.</p>}
          </div>
        </Card>

        <Card className="rounded-[20px]">
          <CardLabel>Outstanding by payer</CardLabel>
          <div className="mt-3 space-y-1.5 text-[12px]">
            {data.outstandingByPayer.map((row) => (
              <div key={row.payerId} className="flex justify-between">
                <span>{row.payerName}</span>
                <span className="tabular-nums text-cyan">{money(row.outstandingMinor)}</span>
              </div>
            ))}
            {data.outstandingByPayer.length === 0 && <p className="text-text-tertiary">Nothing outstanding.</p>}
          </div>
        </Card>

        <Card className="rounded-[20px]">
          <CardLabel>Charge → invoice → collection</CardLabel>
          <div className="mt-3 space-y-1.5 text-[12px]">
            <div className="flex justify-between"><span>Gross charges posted</span><span className="tabular-nums">{money(data.chargeInvoiceCollectionLeakage.grossChargesMinor)}</span></div>
            <div className="flex justify-between"><span>Invoiced</span><span className="tabular-nums">{money(data.chargeInvoiceCollectionLeakage.invoicedMinor)}</span></div>
            <div className="flex justify-between"><span>Collected</span><span className="tabular-nums">{money(data.chargeInvoiceCollectionLeakage.collectedMinor)}</span></div>
          </div>
        </Card>

        <Card className="rounded-[20px]">
          <CardLabel>Claim aging</CardLabel>
          <div className="mt-3 space-y-1.5 text-[12px]">
            {Object.entries(data.claimAging.countByAgeBucket).map(([bucket, count]) => (
              <div key={bucket} className="flex justify-between">
                <span>{bucket === "unsubmitted" ? "Not yet submitted" : `${bucket} days`}</span>
                <span className="tabular-nums">{count} claim(s) · {money(data.claimAging.amountMinorByAgeBucket[bucket] ?? 0)}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
