"use client";

import { useCallback, useEffect, useState } from "react";
import { Boxes, IndianRupee, Inbox, RefreshCw } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { InventoryStock } from "@/components/hospital-os/InventoryStock";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Tab = "stock" | "valuation" | "requests" | "reorder";
const rupees = (minor: number) => `₹${(minor / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

export function InventoryWorkspace() {
  const push = useToastStore((s) => s.push);
  const [tab, setTab] = useState<Tab>("stock");
  const [val, setVal] = useState<any>(null);
  const [requests, setRequests] = useState<any[] | null>(null);
  const [reorder, setReorder] = useState<any[] | null>(null);

  const loadTab = useCallback((t: Tab) => {
    if (t === "valuation") fetch("/api/hospital/inventory/valuation").then((r) => r.json()).then((d) => setVal(d.valuation ?? null));
    if (t === "requests") fetch("/api/hospital/inventory/requests").then((r) => r.json()).then((d) => setRequests(d.requests ?? []));
    if (t === "reorder") fetch("/api/hospital/inventory/reorder-suggestions").then((r) => r.json()).then((d) => setReorder(d.suggestions ?? []));
  }, []);
  useEffect(() => { loadTab(tab); }, [tab, loadTab]);

  async function post(url: string, body: unknown, ok: string) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { push(data.error ?? "Failed.", "red"); return false; }
    push(ok, "emerald"); loadTab(tab); return true;
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <ToastViewport />
      <div className="flex items-center gap-2">
        <Boxes size={18} className="text-cyan" />
        <h1 className="text-[20px] font-semibold tracking-tight">Inventory</h1>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {([["stock", "Stock", Boxes], ["valuation", "Valuation", IndianRupee], ["requests", "Requests", Inbox], ["reorder", "Reorder", RefreshCw]] as const).map(([t, label, Icon]) => (
          <button key={t} onClick={() => setTab(t)} className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] ${tab === t ? "border-cyan/40 bg-cyan/5 text-cyan" : "border-hairline text-text-secondary hover:border-hairline-strong"}`}>
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>

      {tab === "stock" && <InventoryStock />}

      {tab === "valuation" && (
        <div className="space-y-3">
          {!val && <div className="h-24 animate-pulse rounded-[20px] bg-black/[0.04]" />}
          {val && (
            <>
              <Card className="rounded-[20px]"><CardLabel>Inventory valuation (on-hand × actual lot cost)</CardLabel>
                <div className="mt-3 flex flex-wrap gap-2">
                  <div className="rounded-xl border border-hairline px-3 py-2"><p className="text-[20px] font-semibold leading-none text-emerald">{rupees(val.totalValueMinor)}</p><p className="mt-1 text-[10.5px] uppercase tracking-[0.1em] text-text-tertiary">Total value</p></div>
                  <div className="rounded-xl border border-hairline px-3 py-2"><p className="text-[20px] font-semibold leading-none">{Math.round(val.totalOnHandQty)}</p><p className="mt-1 text-[10.5px] uppercase tracking-[0.1em] text-text-tertiary">On-hand qty</p></div>
                  <div className="rounded-xl border border-hairline px-3 py-2"><p className="text-[20px] font-semibold leading-none text-red">{rupees(val.quarantinedValueMinor)}</p><p className="mt-1 text-[10.5px] uppercase tracking-[0.1em] text-text-tertiary">Quarantined</p></div>
                  <div className="rounded-xl border border-hairline px-3 py-2"><p className="text-[20px] font-semibold leading-none text-amber">{rupees(val.expiringValueMinor)}</p><p className="mt-1 text-[10.5px] uppercase tracking-[0.1em] text-text-tertiary">Expiring ≤30d</p></div>
                </div>
                {val.uncostedLots > 0 && <p className="mt-2 text-[11.5px] text-text-tertiary">{val.uncostedLots} lot(s) have no recorded cost and contribute quantity but ₹0 value.</p>}
              </Card>
              <Card className="rounded-[20px]"><CardLabel>Value by category</CardLabel>
                <div className="mt-2 space-y-1">
                  {val.byCategory.map((c: any) => <div key={c.category} className="flex items-center justify-between text-[12.5px]"><span>{c.category}</span><span>{rupees(c.valueMinor)} · {Math.round(c.quantity)} units</span></div>)}
                </div>
              </Card>
            </>
          )}
        </div>
      )}

      {tab === "requests" && (
        <Card className="rounded-[20px]"><CardLabel>Department supply requests</CardLabel>
          <div className="mt-2 space-y-1.5">
            {!requests && <div className="h-16 animate-pulse rounded-xl bg-black/[0.04]" />}
            {requests && requests.length === 0 && <p className="text-[13px] text-text-tertiary">No requests.</p>}
            {requests?.map((r: any) => {
              const next: Record<string, string> = { REQUESTED: "APPROVED", APPROVED: "RESERVED", RESERVED: "ISSUED", ISSUED: "RECEIVED" };
              return (
                <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-1.5 text-[12.5px]">
                  <span>Item {r.itemId.slice(-6)} · qty {r.quantity}{r.urgency !== "ROUTINE" ? ` · ${r.urgency}` : ""}</span>
                  <span className="flex items-center gap-1.5">
                    <StatusPill label={r.status} tone={r.status === "RECEIVED" ? "emerald" : r.status === "REJECTED" || r.status === "CANCELLED" ? "red" : "cyan"} className="rounded-md" />
                    {next[r.status] && <button onClick={() => post(`/api/hospital/inventory/requests/${r.id}/status`, { to: next[r.status] }, `Marked ${next[r.status].toLowerCase()}.`)} className="rounded-md border border-hairline-strong px-2 py-0.5 text-[10.5px] hover:border-cyan/40 hover:text-cyan">→ {next[r.status]}</button>}
                  </span>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {tab === "reorder" && (
        <Card className="rounded-[20px]"><CardLabel>Reorder suggestions (below reorder point — never an automatic PO)</CardLabel>
          <div className="mt-2 space-y-1.5">
            {!reorder && <div className="h-16 animate-pulse rounded-xl bg-black/[0.04]" />}
            {reorder && reorder.length === 0 && <p className="text-[13px] text-text-tertiary">No items below reorder point.</p>}
            {reorder?.map((s: any) => (
              <div key={s.itemId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-1.5 text-[12.5px]">
                <span>{s.name} · {s.sku}</span>
                <span className="text-amber">available {s.available} ≤ reorder {s.reorderPoint}{s.suggestedQuantity ? ` · suggest ${s.suggestedQuantity}` : ""}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
