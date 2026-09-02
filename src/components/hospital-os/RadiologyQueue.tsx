"use client";

import { useEffect, useState } from "react";
import { ScanLine } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";

interface ImagingOrderRow {
  id: string; modality: string; studyDescription: string; priority: string; status: string;
  patient: { fullName: string; uhid: string };
}

export function RadiologyQueue() {
  const push = useToastStore((s) => s.push);
  const [orders, setOrders] = useState<ImagingOrderRow[] | null>(null);
  const [entering, setEntering] = useState<string | null>(null);
  const [findings, setFindings] = useState("");
  const [impression, setImpression] = useState("");
  const [isCritical, setIsCritical] = useState(false);

  function load() {
    fetch("/api/hospital/orders/imaging?status=ORDERED").then((r) => r.json()).then((d) => setOrders(d.orders ?? []));
  }
  useEffect(load, []);

  async function submitReport(orderId: string) {
    if (!findings.trim() || !impression.trim()) return;
    const res = await fetch(`/api/hospital/orders/imaging/${orderId}/report`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ findings, impression, isCritical }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push("Report entered.", "emerald");
    setEntering(null); setFindings(""); setImpression(""); setIsCritical(false); load();
  }

  if (!orders) return <div className="mx-auto max-w-4xl animate-pulse"><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;

  return (
    <div className="mx-auto max-w-4xl">
      <ToastViewport />
      <div className="flex items-center gap-2"><ScanLine size={18} className="text-cyan" /><h1 className="text-[20px] font-semibold tracking-tight">Imaging Queue</h1></div>
      <p className="mt-1 text-[13px] text-text-secondary">{orders.length} pending studies.</p>

      <div className="mt-5 space-y-2.5">
        {orders.map((o) => (
          <Card key={o.id} className="rounded-lg">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[13.5px] font-medium">{o.modality} — {o.studyDescription}</p>
                <p className="text-[11.5px] text-text-tertiary">{o.patient.fullName} · {o.patient.uhid}</p>
              </div>
              <div className="flex items-center gap-2">
                <StatusPill label={o.priority} tone={o.priority === "STAT" ? "red" : "neutral"} className="rounded-md" />
                <button onClick={() => setEntering(entering === o.id ? null : o.id)} className="rounded-md border border-hairline px-3 py-1.5 text-[11.5px] text-text-secondary hover:border-cyan/40 hover:text-cyan">
                  {entering === o.id ? "Cancel" : "Enter report"}
                </button>
              </div>
            </div>
            {entering === o.id && (
              <div className="mt-3 space-y-2 border-t border-hairline pt-3">
                <textarea value={findings} onChange={(e) => setFindings(e.target.value)} placeholder="Findings" rows={2} className="w-full rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12.5px] outline-none focus:border-cyan/40" />
                <textarea value={impression} onChange={(e) => setImpression(e.target.value)} placeholder="Impression" rows={2} className="w-full rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12.5px] outline-none focus:border-cyan/40" />
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 text-[11.5px] text-red"><input type="checkbox" checked={isCritical} onChange={(e) => setIsCritical(e.target.checked)} /> Critical finding</label>
                  <button onClick={() => submitReport(o.id)} className="rounded-md bg-emerald px-3 py-1.5 text-[11.5px] font-medium text-white hover:brightness-110">Submit report</button>
                </div>
              </div>
            )}
          </Card>
        ))}
        {orders.length === 0 && <p className="text-[13px] text-text-tertiary">No pending imaging orders.</p>}
      </div>
    </div>
  );
}
