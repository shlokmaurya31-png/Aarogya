"use client";

import { useCallback, useEffect, useState } from "react";
import { Pill, Boxes, CalendarClock, Inbox, Undo2, ShieldAlert, ClipboardCheck } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { PharmacyWorkspace } from "@/components/hospital-os/PharmacyWorkspace";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface CommandCenter {
  verification: { pendingVerification: number; held: number; rejected: number };
  dispensing: { readyToDispense: number; controlledPending: number };
  inventory: { expiringLots: number; expiredLots: number; quarantinedLots: number; recalledLots: number; lowStock: number };
  returns: { pendingReturns: number };
  requests: { pending: number };
  recalls: { open: number };
}

function Metric({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "red" | "amber" | "cyan" | "neutral" | "emerald" }) {
  const color = tone === "red" ? "text-red" : tone === "amber" ? "text-amber" : tone === "cyan" ? "text-cyan" : tone === "emerald" ? "text-emerald" : "";
  return (
    <div className="rounded-xl border border-hairline px-3 py-2 min-w-[92px]">
      <p className={`text-[20px] font-semibold leading-none ${color}`}>{value}</p>
      <p className="mt-1 text-[10.5px] uppercase tracking-[0.1em] text-text-tertiary">{label}</p>
    </div>
  );
}

type Tab = "verify" | "inventory" | "expiry" | "requests" | "returns" | "recall";

export function PharmacyCommandCenter() {
  const push = useToastStore((s) => s.push);
  const [cc, setCc] = useState<CommandCenter | null>(null);
  const [tab, setTab] = useState<Tab>("verify");
  const [stock, setStock] = useState<any[] | null>(null);
  const [expiry, setExpiry] = useState<any[] | null>(null);
  const [requests, setRequests] = useState<any[] | null>(null);
  const [returns, setReturns] = useState<any[] | null>(null);
  const [recalls, setRecalls] = useState<any[] | null>(null);

  const loadCc = useCallback(() => { fetch("/api/hospital/pharmacy/command-center").then((r) => r.json()).then((d) => setCc(d.commandCenter ?? null)); }, []);
  useEffect(loadCc, [loadCc]);

  const loadTab = useCallback((t: Tab) => {
    if (t === "inventory") fetch("/api/hospital/pharmacy/stock").then((r) => r.json()).then((d) => setStock(d.stock ?? []));
    if (t === "expiry") fetch("/api/hospital/pharmacy/expiry").then((r) => r.json()).then((d) => setExpiry(d.report ?? []));
    if (t === "requests") fetch("/api/hospital/pharmacy/requests").then((r) => r.json()).then((d) => setRequests(d.requests ?? []));
    if (t === "returns") fetch("/api/hospital/pharmacy/returns").then((r) => r.json()).then((d) => setReturns(d.returns ?? []));
    if (t === "recall") fetch("/api/hospital/pharmacy/recall").then((r) => r.json()).then((d) => setRecalls(d.recalls ?? []));
  }, []);
  useEffect(() => { loadTab(tab); }, [tab, loadTab]);

  async function post(url: string, body: unknown, ok: string) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { push(data.error ?? "Failed.", "red"); return false; }
    push(ok, "emerald"); loadCc(); loadTab(tab); return true;
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <ToastViewport />
      <div className="flex items-center gap-2">
        <Pill size={18} className="text-cyan" />
        <h1 className="text-[20px] font-semibold tracking-tight">Pharmacy</h1>
      </div>

      {cc && (
        <Card className="rounded-[20px]">
          <CardLabel>Command center</CardLabel>
          <div className="mt-3 flex flex-wrap gap-2">
            <Metric label="Pending verify" value={cc.verification.pendingVerification} tone="amber" />
            <Metric label="Held" value={cc.verification.held} tone="amber" />
            <Metric label="Ready dispense" value={cc.dispensing.readyToDispense} tone="cyan" />
            <Metric label="Controlled" value={cc.dispensing.controlledPending} tone="red" />
            <Metric label="Expiring" value={cc.inventory.expiringLots} tone="amber" />
            <Metric label="Expired" value={cc.inventory.expiredLots} tone="red" />
            <Metric label="Quarantined" value={cc.inventory.quarantinedLots} tone="red" />
            <Metric label="Recalled" value={cc.inventory.recalledLots} tone="red" />
            <Metric label="Low stock" value={cc.inventory.lowStock} tone="amber" />
            <Metric label="Returns" value={cc.returns.pendingReturns} tone="amber" />
            <Metric label="Requests" value={cc.requests.pending} tone="cyan" />
            <Metric label="Open recalls" value={cc.recalls.open} tone="red" />
          </div>
        </Card>
      )}

      <div className="flex flex-wrap gap-1.5">
        {([["verify", "Verify & Dispense", ClipboardCheck], ["inventory", "Inventory", Boxes], ["expiry", "Expiry", CalendarClock], ["requests", "Requests", Inbox], ["returns", "Returns", Undo2], ["recall", "Recall", ShieldAlert]] as const).map(([t, label, Icon]) => (
          <button key={t} onClick={() => setTab(t)} className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] ${tab === t ? "border-cyan/40 bg-cyan/5 text-cyan" : "border-hairline text-text-secondary hover:border-hairline-strong"}`}>
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>

      {tab === "verify" && <PharmacyWorkspace />}

      {tab === "inventory" && (
        <Card className="rounded-[20px]"><CardLabel>Pharmacy stock (lot / expiry / available)</CardLabel>
          <div className="mt-2 overflow-x-auto">
            {!stock && <div className="h-24 animate-pulse rounded-xl bg-black/[0.04]" />}
            {stock && stock.length === 0 && <p className="text-[13px] text-text-tertiary">No stock.</p>}
            {stock && stock.length > 0 && (
              <table className="w-full text-[12px]">
                <thead><tr className="text-left text-text-tertiary"><th className="py-1 pr-3">Medication</th><th className="pr-3">Lot</th><th className="pr-3">Expiry</th><th className="pr-3">Loc</th><th className="pr-3">Avail</th><th className="pr-3">Resv</th><th>Flags</th></tr></thead>
                <tbody>
                  {stock.map((s: any, i: number) => (
                    <tr key={i} className="border-t border-hairline">
                      <td className="py-1 pr-3">{s.itemName}{s.highAlert ? " ⚠" : ""}{s.controlledClass ? ` · ${s.controlledClass}` : ""}</td>
                      <td className="pr-3">{s.lotNumber}</td>
                      <td className="pr-3">{s.expiresAt ? new Date(s.expiresAt).toLocaleDateString() : "—"}</td>
                      <td className="pr-3">{s.locationName}</td>
                      <td className="pr-3">{s.available}</td>
                      <td className="pr-3">{s.reserved}</td>
                      <td>{[s.quarantined && "QUAR", s.recalled && "RECALL", s.expired && "EXP"].filter(Boolean).map((f: any) => <StatusPill key={f} label={f} tone="red" className="mr-1 rounded-md" />)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>
      )}

      {tab === "expiry" && (
        <Card className="rounded-[20px]"><CardLabel>Expiry exposure (≤30 days + expired)</CardLabel>
          <div className="mt-2 space-y-1.5">
            {!expiry && <div className="h-24 animate-pulse rounded-xl bg-black/[0.04]" />}
            {expiry && expiry.length === 0 && <p className="text-[13px] text-text-tertiary">No lots expiring soon.</p>}
            {expiry?.map((l: any) => (
              <div key={l.lotId} className="flex items-center justify-between rounded-xl border border-hairline px-3 py-1.5 text-[12.5px]">
                <span>{l.itemName} · {l.lotNumber} · on-hand {l.onHand}</span>
                <span className="flex items-center gap-1.5">
                  <span className={l.expired ? "text-red" : "text-amber"}>{l.expiresAt ? new Date(l.expiresAt).toLocaleDateString() : "—"}</span>
                  {l.expired && <StatusPill label="EXPIRED" tone="red" className="rounded-md" />}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {tab === "requests" && (
        <Card className="rounded-[20px]"><CardLabel>Ward / ICU / ED / OT requests</CardLabel>
          <div className="mt-2 space-y-1.5">
            {!requests && <div className="h-24 animate-pulse rounded-xl bg-black/[0.04]" />}
            {requests && requests.length === 0 && <p className="text-[13px] text-text-tertiary">No requests.</p>}
            {requests?.map((r: any) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-1.5 text-[12.5px]">
                <span>Item {r.itemId.slice(-6)} · qty {r.quantity}{r.priority !== "ROUTINE" ? ` · ${r.priority}` : ""}</span>
                <span className="flex items-center gap-1.5">
                  <StatusPill label={r.status} tone={r.status === "RECEIVED" ? "emerald" : r.status === "REJECTED" || r.status === "CANCELLED" ? "red" : "cyan"} className="rounded-md" />
                  {r.status === "REQUESTED" && <button onClick={() => post(`/api/hospital/pharmacy/requests/${r.id}/status`, { to: "APPROVED" }, "Approved.")} className="rounded-md border border-hairline-strong px-2 py-0.5 text-[11px] hover:border-emerald/40 hover:text-emerald">Approve</button>}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {tab === "returns" && (
        <Card className="rounded-[20px]"><CardLabel>Returns — inspect &amp; classify</CardLabel>
          <p className="mt-1 text-[11.5px] text-text-tertiary">A return never re-enters available stock automatically — classify it explicitly.</p>
          <div className="mt-2 space-y-1.5">
            {!returns && <div className="h-24 animate-pulse rounded-xl bg-black/[0.04]" />}
            {returns && returns.length === 0 && <p className="text-[13px] text-text-tertiary">No returns.</p>}
            {returns?.map((r: any) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-1.5 text-[12.5px]">
                <span>Item {r.itemId.slice(-6)} · qty {r.quantity} · {r.source}{r.isControlled ? " · CONTROLLED" : ""}</span>
                <span className="flex flex-wrap items-center gap-1.5">
                  <StatusPill label={r.status.replace(/_/g, " ")} tone={r.status === "COMPLETED" ? "emerald" : "amber"} className="rounded-md" />
                  {r.status === "PENDING_INSPECTION" && (["RETURN_TO_STOCK", "QUARANTINE", "WASTAGE"] as const).map((c) => (
                    <button key={c} onClick={() => post(`/api/hospital/pharmacy/returns/${r.id}/classify`, { classification: c }, `Classified: ${c}.`)} className="rounded-md border border-hairline-strong px-2 py-0.5 text-[10.5px] hover:border-cyan/40 hover:text-cyan">{c.replace(/_/g, " ")}</button>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {tab === "recall" && (
        <Card className="rounded-[20px]"><CardLabel>Recalls</CardLabel>
          <div className="mt-2 space-y-1.5">
            {!recalls && <div className="h-24 animate-pulse rounded-xl bg-black/[0.04]" />}
            {recalls && recalls.length === 0 && <p className="text-[13px] text-text-tertiary">No recalls.</p>}
            {recalls?.map((r: any) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-1.5 text-[12.5px]">
                <span>Item {r.itemId.slice(-6)}{r.batchRef ? ` · batch ${r.batchRef}` : ""} · {r.reason}</span>
                <span className="flex items-center gap-1.5">
                  <StatusPill label={r.status} tone={r.status === "OPEN" ? "red" : "neutral"} className="rounded-md" />
                  {r.status === "OPEN" && <button onClick={() => post(`/api/hospital/pharmacy/recall/${r.id}`, {}, "Recall closed.")} className="rounded-md border border-hairline-strong px-2 py-0.5 text-[11px] hover:border-neutral/40">Close</button>}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
