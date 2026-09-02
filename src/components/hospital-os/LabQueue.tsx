"use client";

import { useEffect, useState } from "react";
import { FlaskConical } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";

interface LabOrderRow {
  id: string; testName: string; category: string; priority: string; status: string;
  patient: { fullName: string; uhid: string };
  result: { value: string; isCritical: boolean } | null;
}

export function LabQueue() {
  const push = useToastStore((s) => s.push);
  const [orders, setOrders] = useState<LabOrderRow[] | null>(null);
  const [entering, setEntering] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState("");
  const [isCritical, setIsCritical] = useState(false);

  function load() {
    fetch("/api/hospital/orders/lab?status=ORDERED").then((r) => r.json()).then((d) => setOrders(d.orders ?? []));
  }
  useEffect(load, []);

  async function submitResult(orderId: string) {
    if (!value.trim()) return;
    const res = await fetch(`/api/hospital/orders/lab/${orderId}/result`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value, unit, isCritical }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push("Result released.", "emerald");
    setEntering(null); setValue(""); setUnit(""); setIsCritical(false); load();
  }

  if (!orders) return <div className="mx-auto max-w-4xl animate-pulse"><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;

  return (
    <div className="mx-auto max-w-4xl">
      <ToastViewport />
      <div className="flex items-center gap-2"><FlaskConical size={18} className="text-cyan" /><h1 className="text-[20px] font-semibold tracking-tight">Lab Queue</h1></div>
      <p className="mt-1 text-[13px] text-text-secondary">{orders.length} pending orders.</p>

      <div className="mt-5 space-y-2.5">
        {orders.map((o) => (
          <Card key={o.id} className="rounded-lg">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[13.5px] font-medium">{o.testName}</p>
                <p className="text-[11.5px] text-text-tertiary">{o.patient.fullName} · {o.patient.uhid} · {o.category}</p>
              </div>
              <div className="flex items-center gap-2">
                <StatusPill label={o.priority} tone={o.priority === "STAT" ? "red" : "neutral"} className="rounded-md" />
                <button onClick={() => setEntering(entering === o.id ? null : o.id)} className="rounded-md border border-hairline px-3 py-1.5 text-[11.5px] text-text-secondary hover:border-cyan/40 hover:text-cyan">
                  {entering === o.id ? "Cancel" : "Enter result"}
                </button>
              </div>
            </div>
            {entering === o.id && (
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
                <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Value" className="w-28 rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12.5px] outline-none focus:border-cyan/40" />
                <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="Unit" className="w-24 rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12.5px] outline-none focus:border-cyan/40" />
                <label className="flex items-center gap-1.5 text-[11.5px] text-red"><input type="checkbox" checked={isCritical} onChange={(e) => setIsCritical(e.target.checked)} /> Critical value</label>
                <button onClick={() => submitResult(o.id)} className="rounded-md bg-emerald px-3 py-1.5 text-[11.5px] font-medium text-white hover:brightness-110">Release result</button>
              </div>
            )}
          </Card>
        ))}
        {orders.length === 0 && <p className="text-[13px] text-text-tertiary">No pending lab orders.</p>}
      </div>
    </div>
  );
}
