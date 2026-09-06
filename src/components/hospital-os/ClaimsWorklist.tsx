"use client";

import { useEffect, useState, useCallback } from "react";
import { ShieldCheck } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { minorToRupees } from "@/lib/hospital/billing/money";

interface ClaimRow {
  id: string;
  claimNumber: string | null;
  status: string;
  submittedAmountMinor: number;
  approvedAmountMinor: number | null;
  denialReason: string | null;
  coverage: { payer: { name: string } };
  invoice: { invoiceNumber: string | null };
}

const TONE: Record<string, "emerald" | "amber" | "red" | "cyan" | "neutral"> = {
  DRAFT: "neutral", SUBMITTED: "cyan", UNDER_REVIEW: "amber", APPROVED: "emerald",
  PARTIALLY_APPROVED: "emerald", REJECTED: "red", SETTLED: "emerald", CLOSED: "neutral",
};

function money(minor: number) {
  return `₹${minorToRupees(minor).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
}

export function ClaimsWorklist() {
  const push = useToastStore((s) => s.push);
  const [claims, setClaims] = useState<ClaimRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [approvedAmount, setApprovedAmount] = useState("");
  const [denialReason, setDenialReason] = useState("");
  const [settledAmount, setSettledAmount] = useState("");

  const load = useCallback(() => {
    fetch("/api/hospital/claims").then((r) => r.json()).then((d) => setClaims(d.claims ?? []));
  }, []);
  useEffect(load, [load]);

  async function submit(id: string) {
    const res = await fetch(`/api/hospital/claims/${id}/submit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (!res.ok) { push((await res.json()).error ?? "Failed to submit claim.", "red"); return; }
    push("Claim submitted.", "emerald");
    load();
  }

  async function decide(id: string, status: "UNDER_REVIEW" | "APPROVED" | "PARTIALLY_APPROVED" | "REJECTED") {
    const body: Record<string, unknown> = { status };
    if (status === "APPROVED" || status === "PARTIALLY_APPROVED") {
      if (!approvedAmount) { push("Enter the approved amount first.", "amber"); return; }
      body.approvedAmountMinor = Math.round(Number(approvedAmount) * 100);
    }
    if (status === "REJECTED") {
      if (!denialReason.trim()) { push("A denial reason is required.", "amber"); return; }
      body.denialReason = denialReason;
    }
    const res = await fetch(`/api/hospital/claims/${id}/decision`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) { push((await res.json()).error ?? "Failed to record decision.", "red"); return; }
    push("Decision recorded.", "emerald");
    setApprovedAmount(""); setDenialReason("");
    load();
  }

  async function settle(id: string) {
    if (!settledAmount) { push("Enter the settled amount first.", "amber"); return; }
    const res = await fetch(`/api/hospital/claims/${id}/settle`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settledAmountMinor: Math.round(Number(settledAmount) * 100) }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed to settle claim.", "red"); return; }
    push("Claim settled — record the payer's payment from Billing → Payments (method: INSURANCE_SETTLEMENT).", "emerald");
    setSettledAmount("");
    load();
  }

  if (!claims) return <div className="mx-auto max-w-5xl animate-pulse"><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;
  const active = claims.find((c) => c.id === selected);

  return (
    <div className="mx-auto max-w-5xl">
      <ToastViewport />
      <div className="flex items-center gap-2"><ShieldCheck size={18} className="text-cyan" /><h1 className="text-[20px] font-semibold tracking-tight">Claims</h1></div>
      <p className="mt-1 text-[13px] text-text-secondary">Insurance claim lifecycle — manual payer-decision entry, no live payer API this phase.</p>

      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
        <Card className="rounded-[20px]">
          <CardLabel>Worklist</CardLabel>
          <div className="mt-3 space-y-2">
            {claims.map((c) => (
              <button key={c.id} onClick={() => setSelected(c.id)} className={`flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left ${selected === c.id ? "border-cyan/40 bg-cyan/[0.04]" : "border-hairline"}`}>
                <div>
                  <p className="text-[13px] font-medium">{c.claimNumber ?? "DRAFT"} · {c.coverage.payer.name}</p>
                  <p className="text-[11px] text-text-tertiary">Invoice {c.invoice.invoiceNumber} · Claimed {money(c.submittedAmountMinor)}</p>
                </div>
                <StatusPill label={c.status} tone={TONE[c.status] ?? "neutral"} className="rounded-md" />
              </button>
            ))}
            {claims.length === 0 && <p className="text-[12px] text-text-tertiary">No claims yet.</p>}
          </div>
        </Card>

        <Card className="rounded-[20px]">
          <CardLabel>Actions</CardLabel>
          {!active ? (
            <p className="mt-3 text-[12.5px] text-text-tertiary">Select a claim to submit or record a decision.</p>
          ) : (
            <div className="mt-3 space-y-3 text-[12px]">
              {active.status === "DRAFT" && (
                <button onClick={() => submit(active.id)} className="w-full rounded-md bg-cyan px-3 py-1.5 font-medium text-ink hover:brightness-110">Submit to payer</button>
              )}
              {(active.status === "SUBMITTED" || active.status === "UNDER_REVIEW") && (
                <div className="space-y-2 border-t border-hairline pt-3">
                  <p className="text-text-tertiary">Record the payer&rsquo;s decision:</p>
                  <input value={approvedAmount} onChange={(e) => setApprovedAmount(e.target.value)} placeholder="Approved amount (₹)" type="number" className="w-full rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 outline-none focus:border-cyan/40" />
                  <div className="flex gap-2">
                    <button onClick={() => decide(active.id, "APPROVED")} className="flex-1 rounded-md border border-emerald-500/30 px-2 py-1.5 text-emerald-600 hover:bg-emerald-500/5">Approve (full)</button>
                    <button onClick={() => decide(active.id, "PARTIALLY_APPROVED")} className="flex-1 rounded-md border border-amber-500/30 px-2 py-1.5 text-amber-600 hover:bg-amber-500/5">Partial</button>
                  </div>
                  <input value={denialReason} onChange={(e) => setDenialReason(e.target.value)} placeholder="Denial reason" className="w-full rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 outline-none focus:border-cyan/40" />
                  <button onClick={() => decide(active.id, "REJECTED")} className="w-full rounded-md border border-red-500/30 px-2 py-1.5 text-red-600 hover:bg-red-500/5">Reject</button>
                  {active.status === "SUBMITTED" && (
                    <button onClick={() => decide(active.id, "UNDER_REVIEW")} className="w-full rounded-md border border-hairline px-2 py-1.5 hover:border-cyan/40">Mark under review</button>
                  )}
                </div>
              )}
              {(active.status === "APPROVED" || active.status === "PARTIALLY_APPROVED") && (
                <div className="space-y-2 border-t border-hairline pt-3">
                  <input value={settledAmount} onChange={(e) => setSettledAmount(e.target.value)} placeholder="Settled amount (₹)" type="number" className="w-full rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 outline-none focus:border-cyan/40" />
                  <button onClick={() => settle(active.id)} className="w-full rounded-md bg-cyan px-3 py-1.5 font-medium text-ink hover:brightness-110">Mark settled</button>
                </div>
              )}
              {active.denialReason && <p className="text-red-600">Denied: {active.denialReason}</p>}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
