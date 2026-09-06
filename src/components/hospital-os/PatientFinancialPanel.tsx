"use client";

import { useEffect, useState, useCallback } from "react";
import { CreditCard, Plus } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { minorToRupees } from "@/lib/hospital/billing/money";

interface Coverage { id: string; memberId: string; status: string; priorityOrder: number; payer: { name: string; type: string }; plan: { name: string } | null }
interface Summary { grossChargesMinor: number; invoicedMinor: number; paidMinor: number; outstandingMinor: number }

function money(minor: number) {
  return `₹${minorToRupees(minor).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
}

/** Embedded in PatientChart's "Financial" tab — read-only summary + coverage list, with a minimal add-coverage form. Role-gated server-side same as every other billing route; this panel just renders whatever the API returns (a 403 surfaces as an empty/error state, never a client-side permission decision). */
export function PatientFinancialPanel({ patientId, encounterId }: { patientId: string; encounterId: string | null }) {
  const push = useToastStore((s) => s.push);
  const [coverages, setCoverages] = useState<Coverage[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [payers, setPayers] = useState<{ id: string; name: string }[]>([]);
  const [payerId, setPayerId] = useState("");
  const [memberId, setMemberId] = useState("");

  const load = useCallback(() => {
    fetch(`/api/hospital/insurance/coverage?patientId=${patientId}`).then((r) => (r.ok ? r.json() : { coverages: [] })).then((d) => setCoverages(d.coverages ?? []));
    fetch("/api/hospital/insurance/payers").then((r) => (r.ok ? r.json() : { payers: [] })).then((d) => setPayers(d.payers ?? []));
    if (encounterId) {
      fetch(`/api/hospital/billing/${encounterId}`).then((r) => (r.ok ? r.json() : null)).then((d) => setSummary(d?.summary ?? null));
    }
  }, [patientId, encounterId]);
  useEffect(load, [load]);

  async function addCoverage() {
    if (!payerId || !memberId.trim()) { push("Payer and member ID are required.", "amber"); return; }
    const res = await fetch("/api/hospital/insurance/coverage", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patientId, payerId, memberId, validFrom: new Date().toISOString() }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed to add coverage.", "red"); return; }
    push("Coverage added.", "emerald");
    setMemberId("");
    load();
  }

  if (coverages === null) return <div className="animate-pulse"><div className="h-40 rounded-[20px] bg-black/[0.04]" /></div>;

  return (
    <div className="space-y-4">
      {summary && (
        <Card className="rounded-[20px]">
          <CardLabel>This encounter&rsquo;s balance</CardLabel>
          <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4 text-[12px]">
            <div><span className="text-text-tertiary">Charges</span><p className="tabular-nums font-medium">{money(summary.grossChargesMinor)}</p></div>
            <div><span className="text-text-tertiary">Invoiced</span><p className="tabular-nums font-medium">{money(summary.invoicedMinor)}</p></div>
            <div><span className="text-text-tertiary">Paid</span><p className="tabular-nums font-medium">{money(summary.paidMinor)}</p></div>
            <div><span className="text-text-tertiary">Outstanding</span><p className="tabular-nums font-medium text-cyan">{money(summary.outstandingMinor)}</p></div>
          </div>
        </Card>
      )}

      <Card className="rounded-[20px]">
        <div className="flex items-center gap-2"><CreditCard size={14} className="text-cyan" /><CardLabel>Insurance coverage</CardLabel></div>
        <div className="mt-3 space-y-2">
          {coverages.map((c) => (
            <div key={c.id} className="flex items-center justify-between text-[12px]">
              <span>{c.payer.name}{c.plan ? ` — ${c.plan.name}` : ""} <span className="text-text-tertiary">({c.memberId})</span></span>
              <StatusPill label={c.priorityOrder === 1 ? "PRIMARY" : `SECONDARY ${c.priorityOrder}`} tone={c.status === "ACTIVE" ? "emerald" : "neutral"} className="rounded-md" />
            </div>
          ))}
          {coverages.length === 0 && <p className="text-[12px] text-text-tertiary">No coverage on file — self-pay.</p>}
        </div>
        <div className="mt-4 flex gap-2 border-t border-hairline pt-3 text-[12px]">
          <select value={payerId} onChange={(e) => setPayerId(e.target.value)} className="rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 outline-none focus:border-cyan/40">
            <option value="">Select payer</option>
            {payers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input value={memberId} onChange={(e) => setMemberId(e.target.value)} placeholder="Member/policy ID" className="flex-1 rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 outline-none focus:border-cyan/40" />
          <button onClick={addCoverage} className="flex items-center gap-1 rounded-md bg-cyan px-3 py-1.5 font-medium text-ink hover:brightness-110"><Plus size={12} /> Add</button>
        </div>
      </Card>
    </div>
  );
}
