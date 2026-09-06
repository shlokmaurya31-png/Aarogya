"use client";

import { useEffect, useState, useCallback } from "react";
import { Settings2 } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { minorToRupees } from "@/lib/hospital/billing/money";

interface Tariff { id: string; chargeCode: string; description: string; unitPriceMinor: number; currency: string; active: boolean; payer: { name: string } }
interface Payer { id: string; name: string; type: string }

function money(minor: number) {
  return `₹${minorToRupees(minor).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
}

export function BillingSettings() {
  const push = useToastStore((s) => s.push);
  const [tab, setTab] = useState<"tariffs" | "payers">("tariffs");
  const [tariffs, setTariffs] = useState<Tariff[] | null>(null);
  const [payers, setPayers] = useState<Payer[] | null>(null);

  const [chargeCode, setChargeCode] = useState("");
  const [tariffDescription, setTariffDescription] = useState("");
  const [category, setCategory] = useState("PROCEDURE");
  const [payerId, setPayerId] = useState("");
  const [priceRupees, setPriceRupees] = useState("");

  const [payerName, setPayerName] = useState("");
  const [payerType, setPayerType] = useState("INSURANCE");

  const loadTariffs = useCallback(() => {
    fetch("/api/hospital/billing/tariffs").then((r) => r.json()).then((d) => setTariffs(d.tariffs ?? []));
  }, []);
  const loadPayers = useCallback(() => {
    fetch("/api/hospital/insurance/payers").then((r) => r.json()).then((d) => setPayers(d.payers ?? []));
  }, []);
  useEffect(() => { loadTariffs(); loadPayers(); }, [loadTariffs, loadPayers]);

  async function createTariff() {
    if (!chargeCode || !tariffDescription || !payerId || !priceRupees) { push("All fields are required.", "amber"); return; }
    const res = await fetch("/api/hospital/billing/tariffs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payerId, chargeCode, description: tariffDescription, category, unitPriceMinor: Math.round(Number(priceRupees) * 100), effectiveFrom: new Date().toISOString() }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed to create tariff.", "red"); return; }
    push("Tariff created.", "emerald");
    setChargeCode(""); setTariffDescription(""); setPriceRupees("");
    loadTariffs();
  }

  async function createPayer() {
    if (!payerName.trim()) { push("Payer name is required.", "amber"); return; }
    const res = await fetch("/api/hospital/insurance/payers", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: payerName, type: payerType }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed to create payer.", "red"); return; }
    push("Payer created.", "emerald");
    setPayerName("");
    loadPayers();
  }

  return (
    <div className="mx-auto max-w-5xl">
      <ToastViewport />
      <div className="flex items-center gap-2"><Settings2 size={18} className="text-cyan" /><h1 className="text-[20px] font-semibold tracking-tight">Billing Settings</h1></div>
      <p className="mt-1 text-[13px] text-text-secondary">Tariffs and payers — effective-dated pricing, never overwriting historical charges.</p>

      <div className="mt-4 flex gap-1 rounded-lg border border-hairline p-1 text-[12px]">
        {(["tariffs", "payers"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 rounded-md py-1.5 capitalize ${tab === t ? "bg-cyan/10 text-cyan" : "text-text-tertiary"}`}>{t}</button>
        ))}
      </div>

      {tab === "tariffs" && (
        <Card className="mt-4 rounded-[20px]">
          <CardLabel>Tariffs</CardLabel>
          <div className="mt-3 space-y-1.5">
            {(tariffs ?? []).map((t) => (
              <div key={t.id} className="flex items-center justify-between text-[12px]">
                <span>{t.chargeCode} — {t.description} <span className="text-text-tertiary">({t.payer.name})</span></span>
                <span className="tabular-nums font-medium">{money(t.unitPriceMinor)}</span>
              </div>
            ))}
            {tariffs?.length === 0 && <p className="text-[12px] text-text-tertiary">No tariffs yet.</p>}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2 border-t border-hairline pt-3 text-[12px]">
            <input value={chargeCode} onChange={(e) => setChargeCode(e.target.value)} placeholder="Charge code" className="rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 outline-none focus:border-cyan/40" />
            <input value={tariffDescription} onChange={(e) => setTariffDescription(e.target.value)} placeholder="Description" className="rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 outline-none focus:border-cyan/40" />
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 outline-none focus:border-cyan/40">
              {["CONSULTATION", "BED", "PROCEDURE", "LAB", "IMAGING", "PHARMACY", "NURSING", "PACKAGE", "OTHER"].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={payerId} onChange={(e) => setPayerId(e.target.value)} className="rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 outline-none focus:border-cyan/40">
              <option value="">Select payer</option>
              {(payers ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input value={priceRupees} onChange={(e) => setPriceRupees(e.target.value)} placeholder="Price (₹)" type="number" className="col-span-2 rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 outline-none focus:border-cyan/40" />
            <button onClick={createTariff} className="col-span-2 rounded-md bg-cyan px-3 py-1.5 font-medium text-ink hover:brightness-110">Create tariff</button>
          </div>
        </Card>
      )}

      {tab === "payers" && (
        <Card className="mt-4 rounded-[20px]">
          <CardLabel>Payers</CardLabel>
          <div className="mt-3 space-y-1.5">
            {(payers ?? []).map((p) => (
              <div key={p.id} className="flex items-center justify-between text-[12px]">
                <span>{p.name}</span>
                <span className="text-text-tertiary">{p.type}</span>
              </div>
            ))}
          </div>
          <div className="mt-4 flex gap-2 border-t border-hairline pt-3 text-[12px]">
            <input value={payerName} onChange={(e) => setPayerName(e.target.value)} placeholder="Payer name" className="flex-1 rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 outline-none focus:border-cyan/40" />
            <select value={payerType} onChange={(e) => setPayerType(e.target.value)} className="rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 outline-none focus:border-cyan/40">
              {["CASH", "INSURANCE", "GOVERNMENT_SCHEME", "CORPORATE_TPA"].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <button onClick={createPayer} className="rounded-md bg-cyan px-3 py-1.5 font-medium text-ink hover:brightness-110">Add</button>
          </div>
        </Card>
      )}
    </div>
  );
}
