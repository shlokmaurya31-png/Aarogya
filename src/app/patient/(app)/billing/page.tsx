"use client";

import { useState } from "react";
import { Card, SectionTitle, Empty, Unavailable, usePatientData, formatDate, rupees, StatusPill } from "@/components/patient-portal/ui";

interface Invoice { id: string; invoiceNumber: string | null; statusLabel: string; totalMinor: number; paidMinor: number; outstandingMinor: number; currency: string; issuedAt: string | null; dueAt: string | null; payable: boolean; lines: { description: string; quantity: number; amountMinor: number }[]; }

export default function BillingPage() {
  const { state } = usePatientData<{ invoices: Invoice[] }>("/api/patient/billing");
  const [msg, setMsg] = useState<string | null>(null);

  async function pay(invoiceId: string) {
    setMsg(null);
    const r = await fetch("/api/patient/billing/pay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invoiceId }) });
    const b = await r.json().catch(() => ({}));
    if (b.status === "PROVIDER_NOT_CONFIGURED") setMsg("Online payment is not available yet. Please pay at the hospital billing desk — the amount due is shown above and is always calculated by the hospital, never the app.");
    else if (!r.ok) setMsg(b.error ?? "Could not start payment.");
    else setMsg("Payment initiated.");
  }

  return (
    <div className="space-y-5">
      <h1 className="text-[18px] font-semibold">Bills</h1>
      {msg && <Card className="border-amber/30 bg-amber/5"><p className="text-[13px] text-amber">{msg}</p></Card>}
      {state.status === "loading" ? <Empty>Loading…</Empty> : state.status === "error" ? <Unavailable label="Billing" /> : state.data.invoices.length === 0 ? (
        <Card><Empty>You have no bills.</Empty></Card>
      ) : (
        state.data.invoices.map((inv) => (
          <Card key={inv.id}>
            <div className="mb-2 flex items-center justify-between">
              <SectionTitle>{inv.invoiceNumber ?? "Bill"}</SectionTitle>
              <StatusPill label={inv.statusLabel} tone={inv.outstandingMinor > 0 ? "warn" : "good"} />
            </div>
            <ul className="mb-3 space-y-1">
              {inv.lines.map((l, i) => <li key={i} className="flex justify-between text-[13px] text-text-secondary"><span>{l.description}</span><span>{rupees(l.amountMinor)}</span></li>)}
            </ul>
            <div className="flex items-center justify-between border-t border-hairline pt-2 text-[13px]">
              <span>Total {rupees(inv.totalMinor)} · Paid {rupees(inv.paidMinor)}</span>
              <span className="font-semibold">{rupees(inv.outstandingMinor)} due</span>
            </div>
            {inv.issuedAt && <div className="mt-1 text-[12px] text-text-tertiary">Issued {formatDate(inv.issuedAt)}{inv.dueAt ? ` · due ${formatDate(inv.dueAt)}` : ""}</div>}
            {inv.payable && <button onClick={() => pay(inv.id)} className="mt-3 rounded-md bg-cyan px-4 py-2 text-[13px] font-medium text-white">Pay {rupees(inv.outstandingMinor)}</button>}
          </Card>
        ))
      )}
    </div>
  );
}
