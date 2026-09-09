"use client";

import { useEffect, useState, useCallback } from "react";
import { HeartPulse, Wind, Activity, Droplet, Cable, Syringe, ListChecks, FileText } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";

interface Rounding {
  encounter: { id: string; patient: { fullName: string; uhid: string; sex: string; ageYears: number | null } };
  location: { bed: { label: string; ward: { name: string }; icuUnit: { name: string } | null } | null } | null;
  vitals: { id: string; hr: number | null; sbp: number | null; dbp: number | null; spo2: number | null; tempC: number | null; recordedAt: string }[];
  observations: { id: string; type: string; values: Record<string, unknown>; recordedAt: string }[];
  infusions: { id: string; drugName: string; rate: number | null; rateUnit: string | null; status: string; startedAt: string }[];
  devices: { id: string; deviceType: string; site: string | null; status: string; insertedAt: string | null }[];
  io: { id: string; ioType: string; category: string; quantityMl: number; recordedAt: string }[];
  medications: { id: string; drugName: string; dose: string; route: string; status: string }[];
  tasks: { id: string; title: string; status: string; priority: string }[];
  notes: { id: string; type: string; status: string; author: { user: { displayName: string } }; createdAt: string }[];
  handoffs: { id: string; summary: string; status: string; urgency: string }[];
  problems: { id: string; diagnosis: string; status: string }[];
  labs: { id: string; testName: string; results: { value: string; unit: string | null }[] }[];
  imaging: { id: string; modality: string; studyDescription: string; reports: { impression: string }[] }[];
}

const VENT_FIELDS = ["mode", "fio2", "peep", "rr", "tidalVolume", "peakPressure", "plateauPressure"];
const NEURO_FIELDS = ["gcsEye", "gcsVerbal", "gcsMotor", "gcsTotal", "pupilLeft", "pupilRight", "sedationScore"];
const ABG_FIELDS = ["ph", "pao2", "paco2", "hco3", "lactate", "o2sat"];

export function IcuWorkspace({ encounterId }: { encounterId: string }) {
  const push = useToastStore((s) => s.push);
  const [data, setData] = useState<Rounding | null>(null);
  const [obsType, setObsType] = useState<"VENTILATOR" | "NEURO" | "ABG">("VENTILATOR");
  const [obsValues, setObsValues] = useState<Record<string, string>>({});
  const [deviceType, setDeviceType] = useState("CENTRAL_LINE");
  const [deviceSite, setDeviceSite] = useState("");
  const [infDrug, setInfDrug] = useState("");
  const [infRate, setInfRate] = useState("");
  const [infUnit, setInfUnit] = useState("mL/hr");

  const load = useCallback(() => {
    fetch(`/api/hospital/icu/encounters/${encounterId}/rounding`).then((r) => r.json()).then((d) => { if (!d.error) setData(d); });
  }, [encounterId]);
  useEffect(load, [load]);

  const obsFields = obsType === "VENTILATOR" ? VENT_FIELDS : obsType === "NEURO" ? NEURO_FIELDS : ABG_FIELDS;

  async function submitObservation() {
    const values: Record<string, string> = {};
    for (const f of obsFields) if (obsValues[f]?.trim()) values[f] = obsValues[f].trim();
    if (Object.keys(values).length === 0) { push("Enter at least one value.", "amber"); return; }
    const res = await fetch(`/api/hospital/icu/encounters/${encounterId}/observations`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: obsType, values }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push(`${obsType} observation recorded.`, "emerald"); setObsValues({}); load();
  }

  async function addDevice() {
    if (!deviceType) return;
    const res = await fetch(`/api/hospital/icu/encounters/${encounterId}/devices`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceType, site: deviceSite || undefined, status: "ACTIVE" }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push("Device recorded.", "emerald"); setDeviceSite(""); load();
  }

  async function setDeviceStatus(id: string, status: string) {
    const res = await fetch(`/api/hospital/icu/devices/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push(`Device ${status.toLowerCase()}.`, "emerald"); load();
  }

  async function addInfusion() {
    if (!infDrug.trim()) { push("Drug name required.", "amber"); return; }
    const res = await fetch(`/api/hospital/icu/encounters/${encounterId}/infusions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ drugName: infDrug.trim(), rate: infRate ? Number(infRate) : undefined, rateUnit: infUnit }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push("Infusion recorded.", "emerald"); setInfDrug(""); setInfRate(""); load();
  }

  async function setInfusionStatus(id: string, status: string) {
    const res = await fetch(`/api/hospital/icu/infusions/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push(`Infusion ${status.toLowerCase()}.`, "emerald"); load();
  }

  if (!data) return <div className="mx-auto max-w-5xl animate-pulse"><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <ToastViewport />
      <div className="flex items-center gap-2">
        <HeartPulse size={18} className="text-cyan" />
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">{data.encounter.patient.fullName}</h1>
          <p className="text-[12px] text-text-secondary">
            {data.encounter.patient.uhid} · {data.encounter.patient.ageYears}{data.encounter.patient.sex[0]?.toUpperCase()}
            {data.location?.bed ? ` · ${data.location.bed.icuUnit?.name ?? data.location.bed.ward.name} · Bed ${data.location.bed.label}` : ""}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Vitals + observations */}
        <Card className="rounded-[20px]">
          <div className="flex items-center gap-2"><Activity size={14} className="text-cyan" /><CardLabel>Latest vitals</CardLabel></div>
          <div className="mt-2 space-y-1">
            {data.vitals.slice(0, 5).map((v) => (
              <p key={v.id} className="text-[11.5px] tabular-nums"><span className="text-text-tertiary">{new Date(v.recordedAt).toLocaleTimeString()}</span> · HR {v.hr ?? "-"} · BP {v.sbp ?? "-"}/{v.dbp ?? "-"} · SpO2 {v.spo2 ?? "-"}% · {v.tempC ?? "-"}°C</p>
            ))}
            {data.vitals.length === 0 && <p className="text-[11.5px] text-text-tertiary">No vitals. Record via the nurse workspace.</p>}
          </div>
        </Card>

        <Card className="rounded-[20px]">
          <div className="flex items-center gap-2"><Wind size={14} className="text-cyan" /><CardLabel>Record observation</CardLabel></div>
          <div className="mt-2 flex gap-1.5">
            {(["VENTILATOR", "NEURO", "ABG"] as const).map((t) => (
              <button key={t} onClick={() => { setObsType(t); setObsValues({}); }} className={`rounded-md px-2 py-1 text-[10.5px] ${obsType === t ? "bg-cyan text-ink" : "border border-hairline text-text-secondary"}`}>{t}</button>
            ))}
          </div>
          <div className="mt-2 grid grid-cols-3 gap-1.5">
            {obsFields.map((f) => (
              <input key={f} value={obsValues[f] ?? ""} onChange={(e) => setObsValues((p) => ({ ...p, [f]: e.target.value }))} placeholder={f} className="rounded-md border border-hairline bg-white px-1.5 py-1 text-[10.5px] outline-none" />
            ))}
          </div>
          <button onClick={submitObservation} className="mt-2 rounded-md bg-cyan px-3 py-1 text-[11px] font-medium text-ink hover:brightness-110">Record</button>
          <div className="mt-2 space-y-0.5">
            {data.observations.slice(0, 5).map((o) => (
              <p key={o.id} className="text-[10.5px] text-text-tertiary">{o.type} · {new Date(o.recordedAt).toLocaleTimeString()} · {Object.entries(o.values).map(([k, v]) => `${k}:${v}`).join(" ")}</p>
            ))}
          </div>
        </Card>

        {/* Devices */}
        <Card className="rounded-[20px]">
          <div className="flex items-center gap-2"><Cable size={14} className="text-cyan" /><CardLabel>Devices / lines</CardLabel></div>
          <div className="mt-2 flex gap-1.5">
            <select value={deviceType} onChange={(e) => setDeviceType(e.target.value)} className="rounded-md border border-hairline bg-white px-1.5 py-1 text-[11px] outline-none">
              {["CENTRAL_LINE", "ARTERIAL_LINE", "URINARY_CATHETER", "DRAIN", "ETT", "TRACHEOSTOMY", "OTHER"].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <input value={deviceSite} onChange={(e) => setDeviceSite(e.target.value)} placeholder="Site" className="flex-1 rounded-md border border-hairline bg-white px-2 py-1 text-[11px] outline-none" />
            <button onClick={addDevice} className="rounded-md bg-cyan px-2 py-1 text-[11px] font-medium text-ink">Add</button>
          </div>
          <div className="mt-2 space-y-1">
            {data.devices.map((d) => (
              <div key={d.id} className="flex items-center justify-between text-[11.5px]">
                <span>{d.deviceType}{d.site ? ` (${d.site})` : ""} <StatusPill label={d.status} tone={d.status === "ACTIVE" ? "cyan" : d.status === "PLANNED" ? "amber" : "neutral"} className="ml-1 rounded-md" /></span>
                {d.status !== "REMOVED" && d.status !== "DISCONTINUED" && (
                  <button onClick={() => setDeviceStatus(d.id, "REMOVED")} className="text-[10px] text-text-tertiary hover:text-red">Remove</button>
                )}
              </div>
            ))}
            {data.devices.length === 0 && <p className="text-[11px] text-text-tertiary">No devices recorded.</p>}
          </div>
        </Card>

        {/* Infusions */}
        <Card className="rounded-[20px]">
          <div className="flex items-center gap-2"><Syringe size={14} className="text-cyan" /><CardLabel>Infusions</CardLabel></div>
          <div className="mt-2 flex gap-1.5">
            <input value={infDrug} onChange={(e) => setInfDrug(e.target.value)} placeholder="Drug" className="flex-1 rounded-md border border-hairline bg-white px-2 py-1 text-[11px] outline-none" />
            <input value={infRate} onChange={(e) => setInfRate(e.target.value)} type="number" placeholder="Rate" className="w-16 rounded-md border border-hairline bg-white px-2 py-1 text-[11px] outline-none" />
            <input value={infUnit} onChange={(e) => setInfUnit(e.target.value)} placeholder="Unit" className="w-20 rounded-md border border-hairline bg-white px-2 py-1 text-[11px] outline-none" />
            <button onClick={addInfusion} className="rounded-md bg-cyan px-2 py-1 text-[11px] font-medium text-ink">Add</button>
          </div>
          <div className="mt-2 space-y-1">
            {data.infusions.map((inf) => (
              <div key={inf.id} className="flex items-center justify-between text-[11.5px]">
                <span>{inf.drugName} {inf.rate ?? "-"} {inf.rateUnit ?? ""} <StatusPill label={inf.status} tone={inf.status === "RUNNING" ? "emerald" : inf.status === "PAUSED" ? "amber" : "neutral"} className="ml-1 rounded-md" /></span>
                {inf.status !== "STOPPED" && (
                  <span className="flex gap-1.5">
                    {inf.status === "RUNNING" && <button onClick={() => setInfusionStatus(inf.id, "PAUSED")} className="text-[10px] text-text-tertiary hover:text-amber">Pause</button>}
                    {inf.status === "PAUSED" && <button onClick={() => setInfusionStatus(inf.id, "RUNNING")} className="text-[10px] text-text-tertiary hover:text-emerald">Resume</button>}
                    <button onClick={() => setInfusionStatus(inf.id, "STOPPED")} className="text-[10px] text-text-tertiary hover:text-red">Stop</button>
                  </span>
                )}
              </div>
            ))}
            {data.infusions.length === 0 && <p className="text-[11px] text-text-tertiary">No infusions recorded.</p>}
          </div>
        </Card>
      </div>

      {/* Rounding composition (read-only) */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="rounded-[20px]">
          <div className="flex items-center gap-2"><Droplet size={14} className="text-cyan" /><CardLabel>Intake / Output</CardLabel></div>
          <div className="mt-2 space-y-0.5">
            {data.io.slice(0, 8).map((r) => <p key={r.id} className="text-[11px]">{r.ioType} · {r.category} · {r.quantityMl}mL</p>)}
            {data.io.length === 0 && <p className="text-[11px] text-text-tertiary">None.</p>}
          </div>
        </Card>
        <Card className="rounded-[20px]">
          <div className="flex items-center gap-2"><ListChecks size={14} className="text-cyan" /><CardLabel>Open tasks · Problems</CardLabel></div>
          <div className="mt-2 space-y-0.5">
            {data.tasks.map((t) => <p key={t.id} className="text-[11px]">{t.title} <span className="text-text-tertiary">({t.priority})</span></p>)}
            {data.problems.map((p) => <p key={p.id} className="text-[11px] text-text-secondary">Problem: {p.diagnosis}</p>)}
            {data.tasks.length === 0 && data.problems.length === 0 && <p className="text-[11px] text-text-tertiary">None.</p>}
          </div>
        </Card>
        <Card className="rounded-[20px]">
          <div className="flex items-center gap-2"><FileText size={14} className="text-cyan" /><CardLabel>Meds · Labs · Notes</CardLabel></div>
          <div className="mt-2 space-y-0.5">
            {data.medications.slice(0, 4).map((m) => <p key={m.id} className="text-[11px]">{m.drugName} {m.dose} ({m.status})</p>)}
            {data.labs.slice(0, 3).map((l) => <p key={l.id} className="text-[11px] text-text-secondary">{l.testName}{l.results[0] ? `: ${l.results[0].value} ${l.results[0].unit ?? ""}` : ""}</p>)}
            {data.notes.slice(0, 2).map((n) => <p key={n.id} className="text-[11px] text-text-tertiary">{n.type} · {n.author.user.displayName}</p>)}
          </div>
        </Card>
      </div>
    </div>
  );
}
