"use client";

import { useEffect, useState } from "react";
import { Receipt, Plus } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";

interface EncounterRow { id: string; type: string; chiefComplaint: string | null; patient: { fullName: string; uhid: string }; bill: { totalAmount: number; status: string } | null }
interface Charge { id: string; description: string; category: string; amount: number; createdAt: string }

export function BillingCenter() {
  const push = useToastStore((s) => s.push);
  const [encounters, setEncounters] = useState<EncounterRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [charges, setCharges] = useState<Charge[]>([]);
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("PROCEDURE");
  const [amount, setAmount] = useState("");

  function load() {
    fetch("/api/hospital/encounters?all=true").then((r) => r.json()).then((d) => setEncounters(d.encounters ?? []));
  }
  useEffect(load, []);

  function openEncounter(id: string) {
    setSelected(id);
    fetch(`/api/hospital/billing/${id}`).then((r) => r.json()).then((d) => setCharges(d.charges ?? []));
  }

  async function addCharge() {
    if (!selected || !description.trim() || !amount) return;
    const res = await fetch(`/api/hospital/billing/${selected}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description, category, amount: Number(amount) }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push("Charge added.", "emerald");
    setDescription(""); setAmount(""); openEncounter(selected); load();
  }

  if (!encounters) return <div className="mx-auto max-w-5xl animate-pulse"><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;

  return (
    <div className="mx-auto max-w-5xl">
      <ToastViewport />
      <div className="flex items-center gap-2"><Receipt size={18} className="text-cyan" /><h1 className="text-[20px] font-semibold tracking-tight">Billing</h1></div>
      <p className="mt-1 text-[13px] text-text-secondary">Charge engine — every charge is sourced, timestamped, and rolls into a bill total.</p>

      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
        <Card className="rounded-[20px]">
          <CardLabel>Encounters</CardLabel>
          <div className="mt-3 space-y-2">
            {encounters.map((e) => (
              <button key={e.id} onClick={() => openEncounter(e.id)} className={`flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left ${selected === e.id ? "border-cyan/40 bg-cyan/[0.04]" : "border-hairline"}`}>
                <div>
                  <p className="text-[13px] font-medium">{e.patient.fullName}</p>
                  <p className="text-[11px] text-text-tertiary">{e.patient.uhid} · {e.type} · {e.chiefComplaint}</p>
                </div>
                <StatusPill label={e.bill ? `₹${e.bill.totalAmount.toLocaleString("en-IN")}` : "No bill"} tone={e.bill?.status === "PAID" ? "emerald" : "amber"} className="rounded-md" />
              </button>
            ))}
          </div>
        </Card>

        <Card className="rounded-[20px]">
          <CardLabel>Charges</CardLabel>
          {!selected ? (
            <p className="mt-3 text-[12.5px] text-text-tertiary">Select an encounter to view charges.</p>
          ) : (
            <>
              <div className="mt-3 space-y-2">
                {charges.map((c) => (
                  <div key={c.id} className="flex items-center justify-between text-[12px]">
                    <span>{c.description} <span className="text-text-tertiary">({c.category})</span></span>
                    <span className="tabular-nums">₹{c.amount.toLocaleString("en-IN")}</span>
                  </div>
                ))}
                {charges.length === 0 && <p className="text-[12px] text-text-tertiary">No charges yet.</p>}
              </div>
              <div className="mt-4 space-y-2 border-t border-hairline pt-3">
                <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" className="w-full rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12.5px] outline-none focus:border-cyan/40" />
                <div className="flex gap-2">
                  <select value={category} onChange={(e) => setCategory(e.target.value)} className="rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12px] outline-none focus:border-cyan/40">
                    {["CONSULTATION", "BED", "PROCEDURE", "LAB", "IMAGING", "PHARMACY", "NURSING", "OTHER"].map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount" type="number" className="flex-1 rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12.5px] outline-none focus:border-cyan/40" />
                </div>
                <button onClick={addCharge} className="flex items-center gap-1.5 rounded-md bg-cyan px-3 py-1.5 text-[12px] font-medium text-ink hover:brightness-110"><Plus size={12} /> Add charge</button>
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
