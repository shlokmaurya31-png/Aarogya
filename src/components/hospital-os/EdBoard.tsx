"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Siren, Clock, FlaskConical, ScanLine, ShieldAlert, Search, Activity } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";

interface EdCard {
  encounterId: string; patientId: string; patientName: string; uhid: string;
  registeredAt: string; triageAcuity: number | null; column: string; status: string; location: string | null;
  attendingDoctor: string | null; waitMinutes: number; pendingLabOrders: number; pendingImagingOrders: number;
  admissionPending: boolean; resuscitation: boolean; isolation: boolean; chiefComplaint: string | null;
}
interface CommandCenter {
  arrival: { arrivalsToday: number; waitingTriage: number; triageComplete: number };
  clinical: { active: number; highAcuity: number; inTreatment: number };
  diagnostics: { pendingLab: number; pendingImaging: number };
  operations: { occupiedEdBays: number; isolation: number };
  dispositionsToday: Record<string, number>;
}

const COLUMNS: { key: string; label: string; tone: "red" | "amber" | "cyan" | "neutral" }[] = [
  { key: "RESUSCITATION", label: "Resuscitation", tone: "red" },
  { key: "HIGH_PRIORITY", label: "High priority", tone: "amber" },
  { key: "STANDARD", label: "Standard", tone: "cyan" },
  { key: "OBSERVATION", label: "Observation", tone: "neutral" },
  { key: "TRIAGE_PENDING", label: "Triage pending", tone: "neutral" },
];
const ACUITY_TONE = (a: number | null): "red" | "amber" | "cyan" | "neutral" => (a == null ? "neutral" : a <= 2 ? "red" : a === 3 ? "amber" : "cyan");

function Metric({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "red" | "amber" | "cyan" | "neutral" | "emerald" }) {
  const color = tone === "red" ? "text-red" : tone === "amber" ? "text-amber" : tone === "cyan" ? "text-cyan" : tone === "emerald" ? "text-emerald" : "";
  return (
    <div className="rounded-xl border border-hairline px-3 py-2 min-w-[92px]">
      <p className={`text-[20px] font-semibold leading-none ${color}`}>{value}</p>
      <p className="mt-1 text-[10.5px] uppercase tracking-[0.1em] text-text-tertiary">{label}</p>
    </div>
  );
}

export function EdBoard() {
  const push = useToastStore((s) => s.push);
  const [cards, setCards] = useState<EdCard[] | null>(null);
  const [cc, setCc] = useState<CommandCenter | null>(null);
  const [query, setQuery] = useState("");
  const [columnFilter, setColumnFilter] = useState<string>("ALL");
  const [triageFor, setTriageFor] = useState<string | null>(null);
  const [acuity, setAcuity] = useState("3");
  const [area, setArea] = useState("STANDARD");
  const [redFlags, setRedFlags] = useState("");

  const load = useCallback(() => {
    fetch("/api/hospital/ed/board").then((r) => r.json()).then((d) => setCards(d.cards ?? []));
    fetch("/api/hospital/ed/command-center").then((r) => r.json()).then((d) => setCc(d.commandCenter ?? null));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 20_000); // live board — brief §25
    return () => clearInterval(t);
  }, [load]);

  async function submitTriage() {
    if (!triageFor) return;
    const res = await fetch(`/api/hospital/encounters/${triageFor}/triage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ acuity: Number(acuity), assignedArea: area, redFlags: redFlags || undefined }),
    });
    const data = await res.json();
    if (!res.ok) { push(data.error ?? "Triage failed.", "red"); return; }
    push("Triage recorded.", "emerald");
    setTriageFor(null); setRedFlags(""); load();
  }

  if (!cards) return <div className="mx-auto max-w-7xl animate-pulse"><div className="h-96 rounded-[20px] bg-black/[0.04]" /></div>;

  const q = query.trim().toLowerCase();
  const filtered = cards.filter((c) =>
    (columnFilter === "ALL" || c.column === columnFilter) &&
    (!q || c.patientName.toLowerCase().includes(q) || c.uhid.toLowerCase().includes(q) || (c.chiefComplaint ?? "").toLowerCase().includes(q))
  );
  const byColumn = Object.fromEntries(COLUMNS.map((c) => [c.key, filtered.filter((card) => card.column === c.key)]));

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <ToastViewport />
      <div className="flex items-center gap-2">
        <Siren size={18} className="text-red" />
        <h1 className="text-[20px] font-semibold tracking-tight">Emergency Department</h1>
      </div>

      {/* Command center */}
      {cc && (
        <Card className="rounded-[20px]">
          <CardLabel>Command center</CardLabel>
          <div className="mt-3 flex flex-wrap gap-2">
            <Metric label="Arrivals today" value={cc.arrival.arrivalsToday} />
            <Metric label="Waiting triage" value={cc.arrival.waitingTriage} tone="amber" />
            <Metric label="Active" value={cc.clinical.active} tone="cyan" />
            <Metric label="High acuity" value={cc.clinical.highAcuity} tone="red" />
            <Metric label="In treatment" value={cc.clinical.inTreatment} />
            <Metric label="Pending lab" value={cc.diagnostics.pendingLab} tone="amber" />
            <Metric label="Pending imaging" value={cc.diagnostics.pendingImaging} tone="amber" />
            <Metric label="Isolation" value={cc.operations.isolation} tone="red" />
          </div>
          {Object.keys(cc.dispositionsToday).length > 0 && (
            <p className="mt-3 text-[11.5px] text-text-tertiary">Dispositions today: {Object.entries(cc.dispositionsToday).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(" · ")}</p>
          )}
        </Card>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 rounded-lg border border-hairline px-2.5 py-1.5">
          <Search size={13} className="text-text-tertiary" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name / UHID / complaint" className="w-56 bg-transparent text-[12.5px] outline-none" />
        </div>
        <select value={columnFilter} onChange={(e) => setColumnFilter(e.target.value)} className="rounded-lg border border-hairline bg-transparent px-2.5 py-1.5 text-[12.5px]">
          <option value="ALL">All columns</option>
          {COLUMNS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
        <span className="text-[12px] text-text-tertiary">{filtered.length} patient(s)</span>
      </div>

      {/* Board columns */}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        {COLUMNS.map((col) => (
          <div key={col.key} className="space-y-2">
            <div className="flex items-center justify-between">
              <StatusPill label={col.label} tone={col.tone} className="rounded-md" />
              <span className="text-[11px] text-text-tertiary">{byColumn[col.key]?.length ?? 0}</span>
            </div>
            {(byColumn[col.key] ?? []).length === 0 && <p className="text-[11px] text-text-tertiary/70">—</p>}
            {(byColumn[col.key] ?? []).map((c) => (
              <Card key={c.encounterId} className="rounded-[16px] p-3">
                <div className="flex items-start justify-between gap-1.5">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium">{c.patientName}</p>
                    <p className="truncate text-[10.5px] text-text-tertiary">{c.uhid}{c.chiefComplaint ? ` · ${c.chiefComplaint}` : ""}</p>
                  </div>
                  {c.triageAcuity != null && <StatusPill label={`A${c.triageAcuity}`} tone={ACUITY_TONE(c.triageAcuity)} className="rounded-md shrink-0" />}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  {c.resuscitation && <StatusPill label="RESUS" tone="red" className="rounded-md" />}
                  {c.isolation && <span className="flex items-center gap-0.5 text-[10px] text-red"><ShieldAlert size={10} /> ISO</span>}
                  <span className="flex items-center gap-0.5 text-[10.5px] text-text-tertiary"><Clock size={10} /> {c.waitMinutes}m</span>
                  {c.pendingLabOrders > 0 && <span className="flex items-center gap-0.5 text-[10.5px] text-amber"><FlaskConical size={10} /> {c.pendingLabOrders}</span>}
                  {c.pendingImagingOrders > 0 && <span className="flex items-center gap-0.5 text-[10.5px] text-amber"><ScanLine size={10} /> {c.pendingImagingOrders}</span>}
                  {c.admissionPending && <StatusPill label="ADMIT?" tone="cyan" className="rounded-md" />}
                </div>
                <p className="mt-1 text-[10.5px] text-text-tertiary">{c.location ?? "No location"}{c.attendingDoctor ? ` · ${c.attendingDoctor}` : ""}</p>
                <div className="mt-2 flex items-center gap-1.5">
                  <Link href={`/hospital-os/ed/${c.encounterId}`} className="flex items-center gap-1 rounded-md border border-hairline-strong px-2 py-0.5 text-[10.5px] hover:border-red/40 hover:text-red"><Activity size={10} /> Open</Link>
                  {c.column === "TRIAGE_PENDING" && <button onClick={() => setTriageFor(c.encounterId)} className="rounded-md border border-hairline-strong px-2 py-0.5 text-[10.5px] hover:border-cyan/40 hover:text-cyan">Triage</button>}
                </div>
              </Card>
            ))}
          </div>
        ))}
      </div>

      {/* Triage quick-action dialog */}
      {triageFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setTriageFor(null)}>
          <Card className="w-full max-w-md rounded-[20px]" onClick={(e) => e.stopPropagation()}>
            <CardLabel>Record triage</CardLabel>
            <p className="mt-1 text-[11.5px] text-text-tertiary">Acuity is a clinician-entered value (1 = resuscitation … 5 = non-urgent) — the system records it, never computes it.</p>
            <div className="mt-3 space-y-2">
              <label className="block text-[12px]">Acuity
                <select value={acuity} onChange={(e) => setAcuity(e.target.value)} className="mt-1 w-full rounded-lg border border-hairline bg-transparent px-2 py-1.5 text-[12.5px]">
                  {[1, 2, 3, 4, 5].map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </label>
              <label className="block text-[12px]">Area
                <select value={area} onChange={(e) => setArea(e.target.value)} className="mt-1 w-full rounded-lg border border-hairline bg-transparent px-2 py-1.5 text-[12.5px]">
                  {["RESUSCITATION", "HIGH_PRIORITY", "STANDARD", "OBSERVATION"].map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </label>
              <label className="block text-[12px]">Red flags (optional)
                <input value={redFlags} onChange={(e) => setRedFlags(e.target.value)} className="mt-1 w-full rounded-lg border border-hairline bg-transparent px-2 py-1.5 text-[12.5px]" />
              </label>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <button onClick={() => setTriageFor(null)} className="rounded-lg border border-hairline px-3 py-1.5 text-[12px]">Cancel</button>
              <button onClick={submitTriage} className="rounded-lg border border-cyan/40 bg-cyan/5 px-3 py-1.5 text-[12px] text-cyan">Record triage</button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
