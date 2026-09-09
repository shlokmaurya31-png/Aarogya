"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { HeartPulse, Wind, Activity, Droplet, Cable, Syringe, FileText, History, ArrowRightLeft, ClipboardList, Pill } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";

interface Vital { id: string; hr: number | null; sbp: number | null; dbp: number | null; rr: number | null; spo2: number | null; tempC: number | null; recordedAt: string }
interface Observation { id: string; type: string; values: Record<string, unknown>; recordedAt: string; recordedByStaffId: string }
interface Rounding {
  encounter: { id: string; registeredAt: string; patient: { fullName: string; uhid: string; sex: string; ageYears: number | null }; attendingStaff: { user: { displayName: string } } | null };
  location: { bed: { label: string; ward: { name: string }; icuUnit: { name: string } | null } | null } | null;
  admission: { id: string; admittedAt: string; admissionType: string | null } | null;
  los: { icuStayHours: number | null; encounterStayHours: number; admittedAt: string | null; icuSince: string | null };
  vitals: Vital[];
  observations: Observation[];
  infusions: { id: string; drugName: string; rate: number | null; rateUnit: string | null; route: string | null; status: string; startedAt: string; medicationOrderId: string | null }[];
  devices: { id: string; deviceType: string; site: string | null; status: string; insertedAt: string | null; removedAt: string | null }[];
  io: { id: string; ioType: string; category: string; quantityMl: number; recordedAt: string }[];
  ioTotals: { totalInputMl: number; totalOutputMl: number; netMl: number; entryCount: number };
  medications: { id: string; drugName: string; dose: string; route: string; status: string }[];
  administrations: { id: string; status: string; administeredAt: string | null; medicationOrder: { drugName: string; dose: string } }[];
  tasks: { id: string; title: string; status: string; priority: string; dueAt: string | null }[];
  notes: { id: string; type: string; status: string; author: { user: { displayName: string } }; createdAt: string }[];
  handoffs: { id: string; summary: string; status: string; urgency: string }[];
  problems: { id: string; diagnosis: string; status: string }[];
  carePlans: { id: string; problem: string; goal: string; status: string; interventions: { id: string; description: string; status: string; responsibleRole: string }[] }[];
  currentAssessment: { id: string; status: string; version: number; createdAt: string } | null;
  labs: { id: string; testName: string; results: { value: string; unit: string | null; isCritical: boolean; abnormalFlag: string | null }[] }[];
  imaging: { id: string; modality: string; studyDescription: string; reports: { impression: string; isCritical: boolean }[] }[];
}
interface TimelineEntry { id: string; timestamp: string; type: string; summary: string; actor?: string | null }

const VENT_FIELDS = ["mode", "fio2", "peep", "rr", "tidalVolume", "peakPressure", "plateauPressure"];
const NEURO_FIELDS = ["gcsEye", "gcsVerbal", "gcsMotor", "gcsTotal", "pupilLeft", "pupilRight", "sedationScore"];
const ABG_FIELDS = ["ph", "pao2", "paco2", "hco3", "lactate", "o2sat"];

export function IcuWorkspace({ encounterId }: { encounterId: string }) {
  const push = useToastStore((s) => s.push);
  const [data, setData] = useState<Rounding | null>(null);
  const [tab, setTab] = useState<"overview" | "flowsheet" | "observations" | "devices" | "infusions" | "timeline" | "note">("overview");
  const [timeline, setTimeline] = useState<TimelineEntry[] | null>(null);

  const [obsType, setObsType] = useState<"VENTILATOR" | "NEURO" | "ABG">("VENTILATOR");
  const [obsValues, setObsValues] = useState<Record<string, string>>({});
  const [deviceType, setDeviceType] = useState("CENTRAL_LINE");
  const [deviceSite, setDeviceSite] = useState("");
  const [infDrug, setInfDrug] = useState("");
  const [infRate, setInfRate] = useState("");
  const [infUnit, setInfUnit] = useState("mL/hr");
  const [noteText, setNoteText] = useState("");

  const load = useCallback(() => {
    fetch(`/api/hospital/icu/encounters/${encounterId}/rounding`).then((r) => r.json()).then((d) => { if (!d.error) setData(d); });
  }, [encounterId]);
  useEffect(load, [load]);

  const loadTimeline = useCallback(() => {
    fetch(`/api/hospital/icu/encounters/${encounterId}/timeline`).then((r) => r.json()).then((d) => setTimeline(d.entries ?? []));
  }, [encounterId]);

  const obsFields = obsType === "VENTILATOR" ? VENT_FIELDS : obsType === "NEURO" ? NEURO_FIELDS : ABG_FIELDS;

  async function submitObservation() {
    const values: Record<string, string> = {};
    for (const f of obsFields) if (obsValues[f]?.trim()) values[f] = obsValues[f].trim();
    if (Object.keys(values).length === 0) { push("Enter at least one value.", "amber"); return; }
    const res = await fetch(`/api/hospital/icu/encounters/${encounterId}/observations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: obsType, values }) });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push(`${obsType} observation recorded.`, "emerald"); setObsValues({}); load();
  }
  async function addDevice() {
    const res = await fetch(`/api/hospital/icu/encounters/${encounterId}/devices`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceType, site: deviceSite || undefined, status: "ACTIVE" }) });
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
    const res = await fetch(`/api/hospital/icu/encounters/${encounterId}/infusions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ drugName: infDrug.trim(), rate: infRate ? Number(infRate) : undefined, rateUnit: infUnit }) });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push("Infusion recorded.", "emerald"); setInfDrug(""); setInfRate(""); load();
  }
  async function setInfusionStatus(id: string, status: string) {
    const res = await fetch(`/api/hospital/icu/infusions/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push(`Infusion ${status.toLowerCase()}.`, "emerald"); load();
  }
  async function signIcuNote() {
    if (!noteText.trim()) { push("Enter note content.", "amber"); return; }
    const res = await fetch(`/api/hospital/encounters/${encounterId}/notes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "ICU_PROGRESS", content: { assessment: noteText.trim() }, sign: true }) });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push("ICU progress note signed.", "emerald"); setNoteText(""); load();
  }

  if (!data) return <div className="mx-auto max-w-5xl animate-pulse"><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;

  const activeDevices = data.devices.filter((d) => d.status === "ACTIVE");
  const activeInfusions = data.infusions.filter((i) => i.status !== "STOPPED");

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <ToastViewport />

      {/* Header */}
      <Card className="rounded-[20px]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <HeartPulse size={18} className="mt-0.5 text-cyan" />
            <div>
              <h1 className="text-[20px] font-semibold tracking-tight">{data.encounter.patient.fullName}</h1>
              <p className="text-[12px] text-text-secondary">
                {data.encounter.patient.uhid} · {data.encounter.patient.ageYears}{data.encounter.patient.sex[0]?.toUpperCase()}
                {data.location?.bed ? ` · ${data.location.bed.icuUnit?.name ?? data.location.bed.ward.name} · Bed ${data.location.bed.label}` : " · No active ICU location"}
                {data.encounter.attendingStaff ? ` · ${data.encounter.attendingStaff.user.displayName}` : ""}
              </p>
              <p className="mt-0.5 text-[11px] text-text-tertiary">
                {data.admission ? `Admitted ${new Date(data.admission.admittedAt).toLocaleString()}${data.admission.admissionType ? ` (${data.admission.admissionType})` : ""}` : "No admission record"}
                {data.los.icuStayHours !== null ? ` · ICU stay ${data.los.icuStayHours}h` : ""} · Encounter {data.los.encounterStayHours}h
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {activeDevices.length > 0 && <StatusPill label={`${activeDevices.length} active device(s)`} tone="cyan" className="rounded-md" />}
            {activeInfusions.length > 0 && <StatusPill label={`${activeInfusions.length} infusion(s)`} tone="emerald" className="rounded-md" />}
            {data.tasks.length > 0 && <StatusPill label={`${data.tasks.length} open task(s)`} tone="amber" className="rounded-md" />}
          </div>
        </div>
      </Card>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2">
        {([["overview", "Overview"], ["flowsheet", "Vitals flowsheet"], ["observations", "Observations"], ["devices", "Devices"], ["infusions", "Infusions"], ["note", "ICU note"], ["timeline", "Timeline"]] as const).map(([id, label]) => (
          <button key={id} onClick={() => { setTab(id); if (id === "timeline") loadTimeline(); }} className={`rounded-full px-3.5 py-1.5 text-[12.5px] ${tab === id ? "bg-cyan text-ink" : "border border-hairline text-text-secondary"}`}>{label}</button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card className="rounded-[20px]">
            <div className="flex items-center gap-2"><Activity size={14} className="text-cyan" /><CardLabel>Latest vitals</CardLabel></div>
            {data.vitals[0] ? (
              <div className="mt-2 text-[12px]">
                <p className="tabular-nums">HR {data.vitals[0].hr ?? "-"} · BP {data.vitals[0].sbp ?? "-"}/{data.vitals[0].dbp ?? "-"} · RR {data.vitals[0].rr ?? "-"} · SpO2 {data.vitals[0].spo2 ?? "-"}% · {data.vitals[0].tempC ?? "-"}°C</p>
                <p className="mt-0.5 text-[10.5px] text-text-tertiary">{new Date(data.vitals[0].recordedAt).toLocaleString()}</p>
              </div>
            ) : <p className="mt-2 text-[11.5px] text-text-tertiary">No vitals recorded.</p>}
          </Card>
          <Card className="rounded-[20px]">
            <div className="flex items-center gap-2"><Droplet size={14} className="text-cyan" /><CardLabel>I/O balance (recent window)</CardLabel></div>
            <p className="mt-2 text-[12px] tabular-nums">In {data.ioTotals.totalInputMl}mL − Out {data.ioTotals.totalOutputMl}mL = <span className={data.ioTotals.netMl >= 0 ? "text-emerald" : "text-amber"}>Net {data.ioTotals.netMl}mL</span></p>
            <p className="mt-0.5 text-[10.5px] text-text-tertiary">{data.ioTotals.entryCount} entries · mL only</p>
          </Card>
          <Card className="rounded-[20px]">
            <div className="flex items-center gap-2"><ClipboardList size={14} className="text-cyan" /><CardLabel>Care plans · Problems</CardLabel></div>
            <div className="mt-2 space-y-0.5">
              {data.carePlans.map((cp) => <p key={cp.id} className="text-[11.5px]">{cp.problem} <span className="text-text-tertiary">({cp.interventions.filter((i) => i.status !== "COMPLETED").length} open)</span></p>)}
              {data.problems.map((p) => <p key={p.id} className="text-[11px] text-text-secondary">Problem: {p.diagnosis}</p>)}
              {data.carePlans.length === 0 && data.problems.length === 0 && <p className="text-[11px] text-text-tertiary">None.</p>}
            </div>
          </Card>
          <Card className="rounded-[20px]">
            <div className="flex items-center gap-2"><Cable size={14} className="text-cyan" /><CardLabel>Active devices</CardLabel></div>
            <div className="mt-2 space-y-0.5">
              {activeDevices.map((d) => <p key={d.id} className="text-[11.5px]">{d.deviceType}{d.site ? ` (${d.site})` : ""} <span className="text-text-tertiary">· since {d.insertedAt ? new Date(d.insertedAt).toLocaleDateString() : "?"}</span></p>)}
              {activeDevices.length === 0 && <p className="text-[11px] text-text-tertiary">None active.</p>}
            </div>
          </Card>
          <Card className="rounded-[20px]">
            <div className="flex items-center gap-2"><Pill size={14} className="text-cyan" /><CardLabel>Meds · MAR · Labs</CardLabel></div>
            <div className="mt-2 space-y-0.5">
              {data.medications.slice(0, 3).map((m) => <p key={m.id} className="text-[11px]">Order: {m.drugName} {m.dose} ({m.status})</p>)}
              {data.administrations.slice(0, 2).map((a) => <p key={a.id} className="text-[11px] text-text-secondary">Given: {a.medicationOrder.drugName} · {a.status}</p>)}
              {data.labs.slice(0, 2).map((l) => <p key={l.id} className="text-[11px] text-text-tertiary">{l.testName}{l.results[0] ? `: ${l.results[0].value}${l.results[0].isCritical ? " ⚠" : ""}` : ""}</p>)}
            </div>
          </Card>
          <Card className="rounded-[20px]">
            <div className="flex items-center gap-2"><ClipboardList size={14} className="text-cyan" /><CardLabel>Nursing · Handoff</CardLabel></div>
            <div className="mt-2 space-y-0.5 text-[11.5px]">
              {data.currentAssessment ? <p>Assessment v{data.currentAssessment.version} <StatusPill label={data.currentAssessment.status} tone={data.currentAssessment.status === "SIGNED" ? "emerald" : "amber"} className="ml-1 rounded-md" /></p> : <p className="text-text-tertiary">No current nursing assessment.</p>}
              {data.handoffs[0] ? <p className="text-text-secondary">Last handoff: {data.handoffs[0].status}</p> : null}
            </div>
          </Card>
        </div>
      )}

      {tab === "flowsheet" && (
        <Card className="rounded-[20px]">
          <div className="flex items-center gap-2"><Activity size={14} className="text-cyan" /><CardLabel>Vitals flowsheet</CardLabel></div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead><tr className="text-left text-[10.5px] uppercase tracking-wide text-text-tertiary">
                <th className="py-1 pr-3">Time</th><th className="pr-3">HR</th><th className="pr-3">BP</th><th className="pr-3">RR</th><th className="pr-3">SpO2</th><th className="pr-3">Temp</th>
              </tr></thead>
              <tbody>
                {data.vitals.map((v) => (
                  <tr key={v.id} className="border-t border-hairline tabular-nums">
                    <td className="py-1 pr-3 text-text-tertiary">{new Date(v.recordedAt).toLocaleString()}</td>
                    <td className="pr-3">{v.hr ?? "-"}</td><td className="pr-3">{v.sbp ?? "-"}/{v.dbp ?? "-"}</td><td className="pr-3">{v.rr ?? "-"}</td><td className="pr-3">{v.spo2 ?? "-"}%</td><td className="pr-3">{v.tempC ?? "-"}°C</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.vitals.length === 0 && <p className="text-[11.5px] text-text-tertiary">No vitals recorded. Record via the nurse workspace.</p>}
          </div>
        </Card>
      )}

      {tab === "observations" && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card className="rounded-[20px]">
            <div className="flex items-center gap-2"><Wind size={14} className="text-cyan" /><CardLabel>Record observation</CardLabel></div>
            <div className="mt-2 flex gap-1.5">
              {(["VENTILATOR", "NEURO", "ABG"] as const).map((t) => (
                <button key={t} onClick={() => { setObsType(t); setObsValues({}); }} className={`rounded-md px-2 py-1 text-[10.5px] ${obsType === t ? "bg-cyan text-ink" : "border border-hairline text-text-secondary"}`}>{t}</button>
              ))}
            </div>
            <div className="mt-2 grid grid-cols-3 gap-1.5">
              {obsFields.map((f) => <input key={f} value={obsValues[f] ?? ""} onChange={(e) => setObsValues((p) => ({ ...p, [f]: e.target.value }))} placeholder={f} className="rounded-md border border-hairline bg-white px-1.5 py-1 text-[10.5px] outline-none" />)}
            </div>
            <button onClick={submitObservation} className="mt-2 rounded-md bg-cyan px-3 py-1 text-[11px] font-medium text-ink hover:brightness-110">Record</button>
          </Card>
          <Card className="rounded-[20px]">
            <CardLabel>Observation history</CardLabel>
            <div className="mt-2 space-y-1.5">
              {data.observations.map((o) => (
                <div key={o.id} className="rounded-md border border-hairline p-2 text-[11px]">
                  <div className="flex items-center justify-between">
                    <StatusPill label={o.type} tone="cyan" className="rounded-md" />
                    <span className="text-[10px] text-text-tertiary">{new Date(o.recordedAt).toLocaleString()}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                    {Object.entries(o.values).map(([k, v]) => <span key={k}><span className="text-text-tertiary">{k}:</span> {String(v)}</span>)}
                  </div>
                </div>
              ))}
              {data.observations.length === 0 && <p className="text-[11px] text-text-tertiary">No observations recorded.</p>}
            </div>
          </Card>
        </div>
      )}

      {tab === "devices" && (
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
                <span>{d.deviceType}{d.site ? ` (${d.site})` : ""} <StatusPill label={d.status} tone={d.status === "ACTIVE" ? "cyan" : d.status === "PLANNED" ? "amber" : "neutral"} className="ml-1 rounded-md" />{d.removedAt ? <span className="ml-1 text-[10px] text-text-tertiary">removed {new Date(d.removedAt).toLocaleDateString()}</span> : null}</span>
                {d.status !== "REMOVED" && d.status !== "DISCONTINUED" && (
                  <span className="flex gap-1.5">
                    {d.status === "PLANNED" && <button onClick={() => setDeviceStatus(d.id, "ACTIVE")} className="text-[10px] text-text-tertiary hover:text-cyan">Activate</button>}
                    <button onClick={() => setDeviceStatus(d.id, "REMOVED")} className="text-[10px] text-text-tertiary hover:text-red">Remove</button>
                  </span>
                )}
              </div>
            ))}
            {data.devices.length === 0 && <p className="text-[11px] text-text-tertiary">No devices recorded.</p>}
          </div>
        </Card>
      )}

      {tab === "infusions" && (
        <Card className="rounded-[20px]">
          <div className="flex items-center gap-2"><Syringe size={14} className="text-cyan" /><CardLabel>Infusions</CardLabel></div>
          <p className="mt-1 text-[10.5px] text-text-tertiary">Infusion tracking references the medication order; it does not itself imply administration (see MAR).</p>
          <div className="mt-2 flex gap-1.5">
            <input value={infDrug} onChange={(e) => setInfDrug(e.target.value)} placeholder="Drug" className="flex-1 rounded-md border border-hairline bg-white px-2 py-1 text-[11px] outline-none" />
            <input value={infRate} onChange={(e) => setInfRate(e.target.value)} type="number" placeholder="Rate" className="w-16 rounded-md border border-hairline bg-white px-2 py-1 text-[11px] outline-none" />
            <input value={infUnit} onChange={(e) => setInfUnit(e.target.value)} placeholder="Unit" className="w-20 rounded-md border border-hairline bg-white px-2 py-1 text-[11px] outline-none" />
            <button onClick={addInfusion} className="rounded-md bg-cyan px-2 py-1 text-[11px] font-medium text-ink">Add</button>
          </div>
          <div className="mt-2 space-y-1">
            {data.infusions.map((inf) => (
              <div key={inf.id} className="flex items-center justify-between text-[11.5px]">
                <span>{inf.drugName} {inf.rate ?? "-"} {inf.rateUnit ?? ""} <StatusPill label={inf.status} tone={inf.status === "RUNNING" ? "emerald" : inf.status === "PAUSED" ? "amber" : "neutral"} className="ml-1 rounded-md" />{inf.medicationOrderId ? <span className="ml-1 text-[10px] text-text-tertiary">order-linked</span> : null}</span>
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
      )}

      {tab === "note" && (
        <Card className="rounded-[20px]">
          <div className="flex items-center gap-2"><FileText size={14} className="text-cyan" /><CardLabel>ICU progress note</CardLabel></div>
          <p className="mt-1 text-[11px] text-text-tertiary">Documentation template — record interval events, current status, respiratory, I/O, devices, assessment and plan. Signed notes are immutable and amended via the patient chart.</p>
          <textarea value={noteText} onChange={(e) => setNoteText(e.target.value)} rows={6} placeholder="Interval events / status / respiratory / I-O / devices / assessment / plan..." className="mt-2 w-full rounded-md border border-hairline bg-black/[0.02] px-3 py-2 text-[13px] outline-none focus:border-cyan/40" />
          <button onClick={signIcuNote} className="mt-2 rounded-md bg-cyan px-4 py-1.5 text-[12.5px] font-medium text-ink hover:brightness-110">Sign &amp; save ICU note</button>
          <div className="mt-3 space-y-1.5">
            {data.notes.map((n) => (
              <div key={n.id} className="rounded-md bg-black/[0.02] p-2 text-[11.5px]">
                <p className="text-text-tertiary">{n.type} · {n.author.user.displayName} · {new Date(n.createdAt).toLocaleString()} · {n.status}</p>
              </div>
            ))}
            {data.notes.length === 0 && <p className="text-[11px] text-text-tertiary">No notes yet.</p>}
          </div>
        </Card>
      )}

      {tab === "timeline" && (
        <Card className="rounded-[20px]">
          <div className="flex items-center gap-2"><History size={14} className="text-cyan" /><CardLabel>ICU timeline</CardLabel></div>
          <div className="mt-3 space-y-1.5">
            {timeline === null && <p className="text-[12px] text-text-tertiary">Loading...</p>}
            {timeline?.map((t) => (
              <div key={t.id} className="flex gap-3 text-[11.5px]">
                <span className="w-40 shrink-0 text-[10.5px] text-text-tertiary">{new Date(t.timestamp).toLocaleString()}</span>
                <span><span className="font-medium">{t.type}:</span> {t.summary}{t.actor ? ` — ${t.actor}` : ""}</span>
              </div>
            ))}
            {timeline?.length === 0 && <p className="text-[12px] text-text-tertiary">No events yet.</p>}
          </div>
        </Card>
      )}

      <p className="flex items-center gap-1.5 text-[11px] text-text-tertiary">
        <ArrowRightLeft size={11} /> Step-down / transfer out is performed from the <Link href="/hospital-os/transfers" className="text-cyan hover:underline">Transfers</Link> workspace using the canonical ADT transfer (devices and infusions are preserved and handled explicitly — never auto-discontinued).
      </p>
    </div>
  );
}
