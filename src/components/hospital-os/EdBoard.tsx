"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Siren, Clock, FlaskConical, ScanLine, BedDouble } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { cn } from "@/lib/utils";

interface EdCard {
  encounterId: string; patientId: string; patientName: string; uhid: string;
  registeredAt: string; triageAcuity: number | null; column: string; location: string | null;
  attendingDoctor: string | null; waitMinutes: number; pendingLabOrders: number; pendingImagingOrders: number;
  admissionPending: boolean; status: string; chiefComplaint: string | null;
}

const COLUMNS: { key: string; label: string; tone: "red" | "amber" | "cyan" | "neutral" }[] = [
  { key: "RESUSCITATION", label: "Resuscitation", tone: "red" },
  { key: "HIGH_PRIORITY", label: "High priority", tone: "amber" },
  { key: "STANDARD", label: "Standard", tone: "cyan" },
  { key: "OBSERVATION", label: "Observation", tone: "neutral" },
  { key: "TRIAGE_PENDING", label: "Triage pending", tone: "neutral" },
];

export function EdBoard() {
  const push = useToastStore((s) => s.push);
  const [byColumn, setByColumn] = useState<Record<string, EdCard[]> | null>(null);
  const [triageFor, setTriageFor] = useState<string | null>(null);
  const [acuity, setAcuity] = useState("3");
  const [area, setArea] = useState("STANDARD");
  const [redFlags, setRedFlags] = useState("");

  function load() {
    fetch("/api/hospital/ed-board").then((r) => r.json()).then((d) => setByColumn(d.byColumn ?? {}));
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 20_000); // brief §55 — board updates without a manual full-page refresh
    return () => clearInterval(t);
  }, []);

  async function submitTriage() {
    if (!triageFor) return;
    const res = await fetch(`/api/hospital/encounters/${triageFor}/triage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ acuity: Number(acuity), assignedArea: area, redFlags: redFlags || undefined }),
    });
    const data = await res.json();
    if (!res.ok) { push(data.error ?? "Triage failed.", "red"); return; }
    push("Triage recorded.", "emerald");
    setTriageFor(null); setRedFlags("");
    load();
  }

  if (!byColumn) return <div className="mx-auto max-w-7xl animate-pulse"><div className="h-96 rounded-[20px] bg-black/[0.04]" /></div>;

  return (
    <div className="mx-auto max-w-7xl">
      <ToastViewport />
      <div className="flex items-center gap-2">
        <Siren size={18} className="text-red" />
        <h1 className="text-[20px] font-semibold tracking-tight">Emergency Department Board</h1>
      </div>
      <p className="mt-1 text-[13px] text-text-secondary">Live — refreshes automatically every 20s.</p>

      <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {COLUMNS.map((col) => (
          <div key={col.key}>
            <div className="mb-2 flex items-center justify-between">
              <StatusPill label={col.label} tone={col.tone} className="rounded-md" />
              <span className="text-[11px] tabular-nums text-text-tertiary">{byColumn[col.key]?.length ?? 0}</span>
            </div>
            <div className="space-y-2">
              {(byColumn[col.key] ?? []).map((c) => (
                <Card key={c.encounterId} className="rounded-lg p-3">
                  <Link href={`/hospital-os/doctor/patients/${c.patientId}?encounterId=${c.encounterId}`} className="text-[12.5px] font-medium hover:text-cyan">
                    {c.patientName}
                  </Link>
                  <p className="text-[10.5px] text-text-tertiary">{c.uhid} · {c.chiefComplaint ?? "—"}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-text-tertiary">
                    <span className="flex items-center gap-0.5"><Clock size={10} /> {c.waitMinutes}m</span>
                    {c.triageAcuity != null && <StatusPill label={`Acuity ${c.triageAcuity}`} tone={c.triageAcuity <= 2 ? "red" : "neutral"} className="rounded-md px-1.5 py-0.5" />}
                    {c.location && <span>{c.location}</span>}
                    {c.pendingLabOrders > 0 && <span className="flex items-center gap-0.5"><FlaskConical size={10} /> {c.pendingLabOrders}</span>}
                    {c.pendingImagingOrders > 0 && <span className="flex items-center gap-0.5"><ScanLine size={10} /> {c.pendingImagingOrders}</span>}
                    {c.admissionPending && <span className="flex items-center gap-0.5 text-cyan"><BedDouble size={10} /> admit pending</span>}
                  </div>
                  <button onClick={() => { setTriageFor(c.encounterId); setArea(c.column === "TRIAGE_PENDING" ? "STANDARD" : c.column); }} className="mt-2 rounded-md border border-hairline-strong px-2 py-1 text-[10.5px] font-medium hover:border-cyan/40 hover:text-cyan">
                    {c.triageAcuity != null ? "Re-triage" : "Triage"}
                  </button>
                </Card>
              ))}
              {(byColumn[col.key] ?? []).length === 0 && <p className="text-[11px] text-text-tertiary">Empty</p>}
            </div>
          </div>
        ))}
      </div>

      {triageFor && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={() => setTriageFor(null)}>
          <Card className={cn("w-full max-w-sm rounded-[20px]")} onClick={(e) => e.stopPropagation()}>
            <CardLabel>Record triage — clinician/nurse judgment, not automated</CardLabel>
            <div className="mt-3 space-y-2.5">
              <div>
                <label className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">Acuity (1 = resuscitation, 5 = non-urgent)</label>
                <select value={acuity} onChange={(e) => setAcuity(e.target.value)} className="mt-1.5 w-full rounded-md border border-hairline bg-black/[0.02] px-3 py-2 text-[13px] outline-none focus:border-cyan/40">
                  {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              <div>
                <label className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">Assigned area</label>
                <select value={area} onChange={(e) => setArea(e.target.value)} className="mt-1.5 w-full rounded-md border border-hairline bg-black/[0.02] px-3 py-2 text-[13px] outline-none focus:border-cyan/40">
                  {COLUMNS.filter((c) => c.key !== "TRIAGE_PENDING").map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
              </div>
              <div>
                <label className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">Red flags (optional)</label>
                <input value={redFlags} onChange={(e) => setRedFlags(e.target.value)} className="mt-1.5 w-full rounded-md border border-hairline bg-black/[0.02] px-3 py-2 text-[13px] outline-none focus:border-cyan/40" />
              </div>
              <div className="flex gap-2">
                <button onClick={submitTriage} className="rounded-md bg-emerald px-4 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110">Save triage</button>
                <button onClick={() => setTriageFor(null)} className="rounded-md border border-hairline-strong px-4 py-1.5 text-[12.5px]">Cancel</button>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
