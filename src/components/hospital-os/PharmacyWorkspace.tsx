"use client";

import { useEffect, useState } from "react";
import { Pill, ShieldAlert, Check, X, Clock3, HelpCircle } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";

interface Warning { id: string; rule: string; severity: string; message: string; acknowledgedAt: string | null }
interface CurrentMed { id: string; drugName: string; dose: string; route: string; frequency: string }
interface QueueOrder {
  id: string; drugName: string; dose: string; route: string; frequency: string; status: string; isControlled: boolean; orderedAt: string;
  patient: { fullName: string; uhid: string; allergies: { substance: string; severity: string }[]; problems: { diagnosis: string }[] };
  orderedBy: { user: { displayName: string } };
  safetyWarnings: Warning[];
  currentMedications: CurrentMed[];
}
interface Dashboard { pendingVerification: number; urgentPending: number; rejected: number; clarificationRequests: number; dispensingQueue: number; controlledQueue: number; delayed: number }

export function PharmacyWorkspace() {
  const push = useToastStore((s) => s.push);
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [queue, setQueue] = useState<QueueOrder[] | null>(null);
  const [statusFilter, setStatusFilter] = useState("PHARMACY_REVIEW");
  const [reasonFor, setReasonFor] = useState<{ orderId: string; decision: string } | null>(null);
  const [reasonText, setReasonText] = useState("");
  const [dispenseFor, setDispenseFor] = useState<string | null>(null);
  const [dispenseQty, setDispenseQty] = useState("30");
  const [dispenseUnit, setDispenseUnit] = useState("tablets");

  function load() {
    fetch("/api/hospital/pharmacy/dashboard").then((r) => r.json()).then(setDash);
    fetch(`/api/hospital/pharmacy/queue?status=${statusFilter}`).then((r) => r.json()).then((d) => setQueue(d.orders ?? []));
  }
  useEffect(load, [statusFilter]);

  async function verify(orderId: string, decision: string, reason?: string) {
    const res = await fetch(`/api/hospital/orders/medication/${orderId}/verify`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision, reason }),
    });
    const data = await res.json();
    if (!res.ok) { push(data.error ?? "Failed.", "red"); return; }
    push(`Order ${decision.toLowerCase().replace("_", " ")}.`, decision === "VERIFIED" ? "emerald" : "amber");
    setReasonFor(null); setReasonText("");
    load();
  }

  async function dispense(orderId: string) {
    const res = await fetch(`/api/hospital/orders/medication/${orderId}/dispense`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantity: Number(dispenseQty), quantityUnit: dispenseUnit, destination: "Ward stock" }),
    });
    const data = await res.json();
    if (!res.ok) { push(data.error ?? "Failed.", "red"); return; }
    push("Dispensed.", "emerald");
    setDispenseFor(null);
    load();
  }

  async function acknowledgeWarning(warningId: string, danger: boolean) {
    const overrideReason = danger ? window.prompt("This is a DANGER-severity warning. Override reason (required)?") : undefined;
    if (danger && !overrideReason) return;
    const res = await fetch(`/api/hospital/medication-safety-warnings/${warningId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ overrideReason }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push("Warning acknowledged.", "cyan");
    load();
  }

  if (!dash || !queue) return <div className="mx-auto max-w-6xl animate-pulse"><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;

  return (
    <div className="mx-auto max-w-6xl">
      <ToastViewport />
      <div className="flex items-center gap-2">
        <Pill size={18} className="text-cyan" />
        <h1 className="text-[20px] font-semibold tracking-tight">Pharmacy Workspace</h1>
      </div>
      <p className="mt-1 text-[13px] text-text-secondary">Medication verification and dispensing.</p>

      <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-7">
        {[
          ["Pending verification", dash.pendingVerification, "cyan"],
          ["Urgent", dash.urgentPending, "red"],
          ["Rejected", dash.rejected, "neutral"],
          ["Clarification", dash.clarificationRequests, "amber"],
          ["Dispensing queue", dash.dispensingQueue, "cyan"],
          ["Controlled", dash.controlledQueue, "amber"],
          ["Delayed", dash.delayed, "red"],
        ].map(([label, value, tone]) => (
          <Card key={label as string} className="rounded-lg p-3">
            <p className="text-[18px] font-semibold tabular-nums">{value}</p>
            <StatusPill label={label as string} tone={tone as never} className="mt-1 rounded-md" />
          </Card>
        ))}
      </div>

      <div className="mt-4 flex gap-1.5">
        {["PHARMACY_REVIEW", "VERIFIED", "HELD", "REJECTED"].map((s) => (
          <button key={s} onClick={() => setStatusFilter(s)} className={`rounded-full px-3 py-1.5 text-[12px] ${statusFilter === s ? "bg-cyan text-ink" : "border border-hairline text-text-secondary"}`}>
            {s.replace("_", " ")}
          </button>
        ))}
      </div>

      <div className="mt-4 space-y-3">
        {queue.map((o) => (
          <Card key={o.id} className="rounded-[20px]">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-[14px] font-medium">{o.drugName} {o.dose} <span className="font-normal text-text-tertiary">· {o.route} · {o.frequency}</span></p>
                <p className="text-[11.5px] text-text-tertiary">{o.patient.fullName} · {o.patient.uhid} · ordered by {o.orderedBy.user.displayName}</p>
              </div>
              <div className="flex items-center gap-1.5">
                {o.isControlled && <StatusPill label="Controlled" tone="amber" className="rounded-md" />}
                <StatusPill label={o.status.replace("_", " ")} tone="neutral" className="rounded-md" />
              </div>
            </div>

            {(o.patient.allergies.length > 0 || o.patient.problems.length > 0) && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {o.patient.allergies.map((a, i) => (
                  <span key={i} className="flex items-center gap-1 rounded-md bg-red/10 px-2 py-0.5 text-[10.5px] text-red"><ShieldAlert size={10} /> Allergy: {a.substance}</span>
                ))}
                {o.patient.problems.map((p, i) => <StatusPill key={i} label={p.diagnosis} tone="neutral" className="rounded-md" />)}
              </div>
            )}

            {o.currentMedications.length > 0 && (
              <p className="mt-1.5 text-[11px] text-text-tertiary">Other active meds: {o.currentMedications.map((m) => `${m.drugName} ${m.dose}`).join(", ")}</p>
            )}

            {o.safetyWarnings.length > 0 && (
              <div className="mt-2.5 space-y-1.5 border-t border-hairline pt-2.5">
                {o.safetyWarnings.map((w) => (
                  <div key={w.id} className={`flex items-center justify-between rounded-md px-2.5 py-1.5 text-[11.5px] ${w.severity === "DANGER" ? "bg-red/10 text-red" : "bg-amber/10 text-amber"}`}>
                    <span className="flex items-center gap-1.5"><ShieldAlert size={12} /> {w.message}</span>
                    {!w.acknowledgedAt && <button onClick={() => acknowledgeWarning(w.id, w.severity === "DANGER")} className="rounded-md border border-current px-2 py-0.5 text-[10px] font-medium">Acknowledge</button>}
                  </div>
                ))}
              </div>
            )}

            {reasonFor?.orderId === o.id && (
              <div className="mt-2.5 flex items-center gap-2 border-t border-hairline pt-2.5">
                <input value={reasonText} onChange={(e) => setReasonText(e.target.value)} placeholder="Reason (required)" className="flex-1 rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12px] outline-none focus:border-cyan/40" />
                <button onClick={() => reasonText.trim() && verify(o.id, reasonFor.decision, reasonText)} disabled={!reasonText.trim()} className="rounded-md bg-red px-3 py-1.5 text-[11.5px] font-medium text-white disabled:opacity-40">Confirm</button>
                <button onClick={() => { setReasonFor(null); setReasonText(""); }} className="rounded-md border border-hairline-strong px-3 py-1.5 text-[11.5px]">Cancel</button>
              </div>
            )}

            {dispenseFor === o.id && (
              <div className="mt-2.5 flex items-center gap-2 border-t border-hairline pt-2.5">
                <input value={dispenseQty} onChange={(e) => setDispenseQty(e.target.value)} placeholder="Qty" className="w-20 rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12px] outline-none" />
                <input value={dispenseUnit} onChange={(e) => setDispenseUnit(e.target.value)} placeholder="Unit" className="w-28 rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12px] outline-none" />
                <button onClick={() => dispense(o.id)} className="rounded-md bg-emerald px-3 py-1.5 text-[11.5px] font-medium text-white">Confirm dispense</button>
                <button onClick={() => setDispenseFor(null)} className="rounded-md border border-hairline-strong px-3 py-1.5 text-[11.5px]">Cancel</button>
              </div>
            )}

            {o.status === "PHARMACY_REVIEW" && !reasonFor && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                <button onClick={() => verify(o.id, "VERIFIED")} className="flex items-center gap-1 rounded-md bg-emerald px-3 py-1.5 text-[11.5px] font-medium text-white hover:brightness-110"><Check size={11} /> Verify</button>
                <button onClick={() => setReasonFor({ orderId: o.id, decision: "REJECTED" })} className="flex items-center gap-1 rounded-md border border-hairline-strong px-3 py-1.5 text-[11.5px] hover:border-red/40 hover:text-red"><X size={11} /> Reject</button>
                <button onClick={() => setReasonFor({ orderId: o.id, decision: "HOLD" })} className="flex items-center gap-1 rounded-md border border-hairline-strong px-3 py-1.5 text-[11.5px] hover:border-amber/40 hover:text-amber"><Clock3 size={11} /> Hold</button>
                <button onClick={() => setReasonFor({ orderId: o.id, decision: "CLARIFICATION_REQUESTED" })} className="flex items-center gap-1 rounded-md border border-hairline-strong px-3 py-1.5 text-[11.5px] hover:border-cyan/40 hover:text-cyan"><HelpCircle size={11} /> Request clarification</button>
              </div>
            )}
            {o.status === "VERIFIED" && dispenseFor !== o.id && (
              <button onClick={() => setDispenseFor(o.id)} className="mt-3 rounded-md bg-cyan px-3 py-1.5 text-[11.5px] font-medium text-ink hover:brightness-110">Dispense</button>
            )}
          </Card>
        ))}
        {queue.length === 0 && <p className="text-[13px] text-text-tertiary">Nothing in this queue.</p>}
      </div>
    </div>
  );
}
