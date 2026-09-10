"use client";

import { useCallback, useEffect, useState } from "react";
import { Truck, FileText, ScrollText, ReceiptText, BarChart3 } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { Procurement } from "@/components/hospital-os/Procurement";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Tab = "pipeline" | "rfq" | "contracts" | "invoices" | "performance";
const rupees = (minor: number) => `₹${(minor / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

export function ProcurementWorkspace() {
  const push = useToastStore((s) => s.push);
  const [tab, setTab] = useState<Tab>("pipeline");
  const [rfqs, setRfqs] = useState<any[] | null>(null);
  const [contracts, setContracts] = useState<any[] | null>(null);
  const [invoices, setInvoices] = useState<any[] | null>(null);
  const [perf, setPerf] = useState<any[] | null>(null);
  const [comparison, setComparison] = useState<any | null>(null);

  const loadTab = useCallback((t: Tab) => {
    if (t === "rfq") fetch("/api/hospital/procurement/rfq").then((r) => r.json()).then((d) => setRfqs(d.rfqs ?? []));
    if (t === "contracts") fetch("/api/hospital/procurement/contracts").then((r) => r.json()).then((d) => setContracts(d.contracts ?? []));
    if (t === "invoices") fetch("/api/hospital/procurement/invoices").then((r) => r.json()).then((d) => setInvoices(d.invoices ?? []));
    if (t === "performance") fetch("/api/hospital/procurement/supplier-performance").then((r) => r.json()).then((d) => setPerf(d.performance ?? []));
  }, []);
  useEffect(() => { loadTab(tab); }, [tab, loadTab]);

  async function post(url: string, body: unknown, ok: string) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { push(data.error ?? "Failed.", "red"); return false; }
    push(ok, "emerald"); loadTab(tab); return true;
  }
  async function loadComparison(rfqId: string) {
    const d = await fetch(`/api/hospital/procurement/rfq/${rfqId}/comparison`).then((r) => r.json());
    setComparison(d.error ? null : d);
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <ToastViewport />
      <div className="flex items-center gap-2">
        <Truck size={18} className="text-cyan" />
        <h1 className="text-[20px] font-semibold tracking-tight">Procurement</h1>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {([["pipeline", "Requisitions & POs", Truck], ["rfq", "RFQ & Comparison", FileText], ["contracts", "Contracts", ScrollText], ["invoices", "Invoices (3-way match)", ReceiptText], ["performance", "Supplier Performance", BarChart3]] as const).map(([t, label, Icon]) => (
          <button key={t} onClick={() => setTab(t)} className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] ${tab === t ? "border-cyan/40 bg-cyan/5 text-cyan" : "border-hairline text-text-secondary hover:border-hairline-strong"}`}>
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>

      {tab === "pipeline" && <Procurement />}

      {tab === "rfq" && (
        <div className="space-y-3">
          <Card className="rounded-[20px]"><CardLabel>Requests for quotation</CardLabel>
            <div className="mt-2 space-y-1.5">
              {!rfqs && <div className="h-16 animate-pulse rounded-xl bg-black/[0.04]" />}
              {rfqs && rfqs.length === 0 && <p className="text-[13px] text-text-tertiary">No RFQs. Create one from an approved requisition (procurement API).</p>}
              {rfqs?.map((r: any) => (
                <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-1.5 text-[12.5px]">
                  <span>{r.rfqNumber ?? r.id.slice(-6)} · {r.lines.length} line(s) · {r.quotations.length} quote(s)</span>
                  <span className="flex items-center gap-1.5">
                    <StatusPill label={r.status} tone={r.status === "CLOSED" ? "emerald" : r.status === "CANCELLED" ? "red" : "cyan"} className="rounded-md" />
                    <button onClick={() => loadComparison(r.id)} className="rounded-md border border-hairline-strong px-2 py-0.5 text-[10.5px] hover:border-cyan/40 hover:text-cyan">Compare</button>
                  </span>
                </div>
              ))}
            </div>
          </Card>
          {comparison && (
            <Card className="rounded-[20px]"><CardLabel>Vendor comparison (cheapest total first — selection is a human decision)</CardLabel>
              <div className="mt-2 space-y-1.5">
                {comparison.quotations.length === 0 && <p className="text-[13px] text-text-tertiary">No quotations recorded.</p>}
                {comparison.quotations.map((q: any) => (
                  <div key={q.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-1.5 text-[12.5px]">
                    <span>{q.supplier.name} · {rupees(q.totalMinor)}{q.deliveryDays != null ? ` · ${q.deliveryDays}d` : ""}</span>
                    <span className="flex items-center gap-1.5">
                      {q.selected ? <StatusPill label="SELECTED" tone="emerald" className="rounded-md" /> : q.status === "REJECTED" ? <StatusPill label="REJECTED" tone="red" className="rounded-md" /> : (
                        <button onClick={() => post(`/api/hospital/procurement/quotations/${q.id}/select`, {}, "Supplier selected.").then((ok) => { if (ok) loadComparison(comparison.rfq.id); })} className="rounded-md border border-hairline-strong px-2 py-0.5 text-[10.5px] hover:border-emerald/40 hover:text-emerald">Select</button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}

      {tab === "contracts" && (
        <Card className="rounded-[20px]"><CardLabel>Supplier contracts / effective pricing</CardLabel>
          <div className="mt-2 space-y-1.5">
            {!contracts && <div className="h-16 animate-pulse rounded-xl bg-black/[0.04]" />}
            {contracts && contracts.length === 0 && <p className="text-[13px] text-text-tertiary">No contracts.</p>}
            {contracts?.map((c: any) => (
              <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-1.5 text-[12.5px]">
                <span>{c.supplier.name} · item {c.itemId.slice(-6)} · {rupees(c.agreedPriceMinor)}{c.moq ? ` · MOQ ${c.moq}` : ""}</span>
                <StatusPill label={c.active ? "ACTIVE" : "INACTIVE"} tone={c.active ? "emerald" : "neutral"} className="rounded-md" />
              </div>
            ))}
          </div>
        </Card>
      )}

      {tab === "invoices" && (
        <Card className="rounded-[20px]"><CardLabel>Supplier invoices — three-way match (PO / GR / Invoice)</CardLabel>
          <div className="mt-2 space-y-1.5">
            {!invoices && <div className="h-16 animate-pulse rounded-xl bg-black/[0.04]" />}
            {invoices && invoices.length === 0 && <p className="text-[13px] text-text-tertiary">No invoices.</p>}
            {invoices?.map((v: any) => (
              <div key={v.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-1.5 text-[12.5px]">
                <span>{v.supplier.name} · {v.invoiceRef} · {rupees(v.totalMinor)}{[v.quantityMismatch && "qty≠", v.priceMismatch && "price≠", v.missingReceipt && "no-GR"].filter(Boolean).length ? ` · ${[v.quantityMismatch && "qty≠", v.priceMismatch && "price≠", v.missingReceipt && "no-GR"].filter(Boolean).join(" ")}` : ""}</span>
                <span className="flex items-center gap-1.5">
                  <StatusPill label={v.status} tone={v.status === "MATCHED" || v.status === "APPROVED" ? "emerald" : v.status === "DISCREPANCY" || v.status === "REJECTED" ? "red" : "amber"} className="rounded-md" />
                  {(v.status === "MATCHED" || v.status === "DISCREPANCY" || v.status === "RECEIVED") && (["APPROVED", "REJECTED"] as const).map((s) => <button key={s} onClick={() => post(`/api/hospital/procurement/invoices/${v.id}/review`, { to: s }, `Invoice ${s.toLowerCase()}.`)} className="rounded-md border border-hairline-strong px-2 py-0.5 text-[10.5px] hover:border-cyan/40 hover:text-cyan">{s === "APPROVED" ? "Approve" : "Reject"}</button>)}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {tab === "performance" && (
        <Card className="rounded-[20px]"><CardLabel>Supplier performance (derived from procurement data)</CardLabel>
          <div className="mt-2 space-y-1.5">
            {!perf && <div className="h-16 animate-pulse rounded-xl bg-black/[0.04]" />}
            {perf && perf.length === 0 && <p className="text-[13px] text-text-tertiary">No suppliers.</p>}
            {perf?.map((p: any) => (
              <div key={p.supplierId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-1.5 text-[12.5px]">
                <span>{p.name} · {p.purchaseOrders} PO(s)</span>
                <span className="text-text-tertiary">accepted {Math.round(p.acceptedQty)} · rejected {Math.round(p.rejectedQty)} · rejection {p.rejectionRate}%</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
