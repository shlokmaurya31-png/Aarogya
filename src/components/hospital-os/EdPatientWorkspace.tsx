"use client";

import { useCallback, useEffect, useState } from "react";
import { Siren, ShieldAlert, Activity, History, HeartPulse, FlaskConical, Pill, LogOut, MapPin } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Workspace {
  id: string; facilityId: string; patientId: string; status: string; chiefComplaint: string | null; triageLevel: number | null; registeredAt: string;
  patient: { fullName: string; uhid: string; sex: string; ageYears: number | null };
  attendingStaff: { user: { displayName: string } } | null;
  triageAssessments: any[]; edReassessments: any[]; edResuscitations: any[]; edDisposition: any | null;
  locations: any[]; vitals: any[]; notes: any[]; labOrders: any[]; imagingOrders: any[]; medicationOrders: any[];
  handoffs: any[]; nursingAssignments: any[]; bloodRequests: any[];
}

const STATUS_TONE: Record<string, "emerald" | "amber" | "red" | "cyan" | "neutral"> = {
  REGISTERED: "neutral", TRIAGED: "amber", IN_CONSULTATION: "cyan", INVESTIGATING: "cyan", ADMITTED: "emerald", DISCHARGED: "neutral", CLOSED: "neutral", CANCELLED: "red",
};
const DISPOSITIONS = ["DISCHARGE", "ADMIT_WARD", "ADMIT_ICU", "TO_OT", "TRANSFER_OUT", "REFERRAL", "LAMA", "DAMA", "LWBS", "ABSCONDED", "DECEASED"];

export function EdPatientWorkspace({ encounterId }: { encounterId: string }) {
  const push = useToastStore((s) => s.push);
  const [w, setW] = useState<Workspace | null>(null);
  const [tab, setTab] = useState<"overview" | "triage" | "vitals" | "diagnostics" | "reassess" | "timeline" | "disposition">("overview");
  const [timeline, setTimeline] = useState<any[] | null>(null);
  const [findings, setFindings] = useState(""); const [escalate, setEscalate] = useState(false);
  const [dispType, setDispType] = useState("DISCHARGE"); const [dispReason, setDispReason] = useState(""); const [dispBed, setDispBed] = useState("");
  const [area, setArea] = useState("");

  const load = useCallback(() => {
    fetch(`/api/hospital/ed/encounters/${encounterId}/workspace`).then((r) => r.json()).then((d) => { if (!d.error) setW(d.workspace); });
  }, [encounterId]);
  useEffect(load, [load]);

  async function post(url: string, body: unknown, ok: string, method = "POST") {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { push(data.error ?? "Failed.", "red"); return false; }
    push(ok, "emerald"); load(); return true;
  }
  async function loadTimeline() {
    setTimeline(null);
    const d = await fetch(`/api/hospital/ed/encounters/${encounterId}/timeline`).then((r) => r.json());
    setTimeline(d.timeline ?? []);
  }

  if (!w) return <div className="mx-auto max-w-5xl animate-pulse"><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;
  const activeResus = w.edResuscitations.find((r) => r.status !== "CLOSED");
  const currentLocation = w.locations.find((l) => !l.releasedAt);
  const terminal = ["DISCHARGED", "CLOSED", "CANCELLED"].includes(w.status);
  const triageIso = w.triageAssessments[0]?.isolationRequired;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <ToastViewport />

      {/* Patient safety banner */}
      <Card className={`rounded-[20px] ${activeResus ? "border-red/40" : "border-red/20"}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <Siren size={18} className="mt-0.5 text-red" />
            <div>
              <p className="text-[18px] font-semibold leading-tight">{w.patient.fullName}</p>
              <p className="text-[12px] text-text-tertiary">UHID {w.patient.uhid} · {w.patient.sex}{w.patient.ageYears != null ? ` · ${w.patient.ageYears}y` : ""}{currentLocation ? ` · ${currentLocation.bed ? currentLocation.bed.label : currentLocation.areaLabel}` : ""}</p>
              <p className="mt-1 text-[13px]">{w.chiefComplaint ?? "No chief complaint recorded"}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {activeResus && <StatusPill label="RESUSCITATION" tone="red" className="rounded-md" />}
            {triageIso && <span className="flex items-center gap-0.5 text-[11px] text-red"><ShieldAlert size={12} /> ISOLATION</span>}
            {w.triageLevel != null && <StatusPill label={`Acuity ${w.triageLevel}`} tone={w.triageLevel <= 2 ? "red" : w.triageLevel === 3 ? "amber" : "cyan"} className="rounded-md" />}
            <StatusPill label={w.status.replace(/_/g, " ")} tone={STATUS_TONE[w.status] ?? "neutral"} className="rounded-md" />
          </div>
        </div>
        {!terminal && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {!activeResus && <button onClick={() => post(`/api/hospital/ed/encounters/${encounterId}/resuscitation`, { reason: "High-acuity activation" }, "Resuscitation activated.")} className="flex items-center gap-1 rounded-md border border-red/40 px-2.5 py-1 text-[11px] text-red"><HeartPulse size={11} /> Activate resuscitation</button>}
            {activeResus && activeResus.status !== "CLOSED" && <button onClick={() => post(`/api/hospital/ed/resuscitations/${activeResus.id}/status`, { to: "CLOSED" }, "Resuscitation closed.")} className="rounded-md border border-hairline-strong px-2.5 py-1 text-[11px]">Close resuscitation</button>}
          </div>
        )}
      </Card>

      {/* Tabs */}
      <div className="flex flex-wrap gap-1.5">
        {([["overview", "Overview", Activity], ["triage", "Triage", Siren], ["vitals", "Vitals", HeartPulse], ["diagnostics", "Diagnostics", FlaskConical], ["reassess", "Reassess", Activity], ["timeline", "Timeline", History], ["disposition", "Disposition", LogOut]] as const).map(([t, label, Icon]) => (
          <button key={t} onClick={() => { setTab(t); if (t === "timeline") loadTimeline(); }} className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] ${tab === t ? "border-red/40 bg-red/5 text-red" : "border-hairline text-text-secondary hover:border-hairline-strong"}`}>
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="grid gap-3 md:grid-cols-2">
          <Card className="rounded-[20px]"><CardLabel>Location</CardLabel>
            <p className="mt-2 flex items-center gap-1 text-[13px]"><MapPin size={13} className="text-cyan" /> {currentLocation ? (currentLocation.bed ? `${currentLocation.bed.label} (${currentLocation.bed.ward.name})` : currentLocation.areaLabel) : "No active location"}</p>
            {!terminal && (
              <div className="mt-2 flex items-center gap-1.5">
                <input value={area} onChange={(e) => setArea(e.target.value)} placeholder="Area label (e.g. CT, Bay 3)" className="flex-1 rounded-lg border border-hairline bg-transparent px-2 py-1 text-[12px]" />
                <button disabled={!area} onClick={() => post(`/api/hospital/ed/encounters/${encounterId}/location`, { areaLabel: area }, "Location updated.").then((ok) => ok && setArea(""))} className="rounded-md border border-hairline-strong px-2.5 py-1 text-[11px] disabled:opacity-40">Assign</button>
              </div>
            )}
          </Card>
          <Card className="rounded-[20px]"><CardLabel>Care team &amp; nursing</CardLabel>
            <p className="mt-2 text-[12.5px]">Attending: {w.attendingStaff?.user.displayName ?? "—"}</p>
            <p className="text-[12.5px]">Nurse: {w.nursingAssignments[0]?.nurse?.user?.displayName ?? "—"}</p>
            <p className="mt-1 text-[11.5px] text-text-tertiary">{w.notes.length} note(s) · {w.handoffs.length} handoff(s) · {w.bloodRequests.length} blood request(s)</p>
          </Card>
        </div>
      )}

      {tab === "triage" && (
        <Card className="rounded-[20px]"><CardLabel>Triage history</CardLabel>
          <div className="mt-2 space-y-2">
            {w.triageAssessments.length === 0 && <p className="text-[13px] text-text-tertiary">No triage recorded yet — record it from the ED board.</p>}
            {w.triageAssessments.map((t) => (
              <div key={t.id} className="rounded-xl border border-hairline px-3 py-2 text-[12.5px]">
                <div className="flex items-center justify-between">
                  <span>Acuity {t.acuity}{t.assignedArea ? ` · ${t.assignedArea}` : ""}</span>
                  <StatusPill label={t.status} tone={t.status === "AMENDED" ? "amber" : t.status === "DRAFT" ? "neutral" : "emerald"} className="rounded-md" />
                </div>
                {t.redFlags && <p className="mt-0.5 text-[11.5px] text-red">Red flags: {t.redFlags}</p>}
                {(t.painScore != null || t.mentalStatus) && <p className="text-[11px] text-text-tertiary">Pain {t.painScore ?? "—"} · {t.mentalStatus ?? "—"}</p>}
                <p className="text-[10.5px] text-text-tertiary">{new Date(t.createdAt).toLocaleString()}</p>
              </div>
            ))}
          </div>
        </Card>
      )}

      {tab === "vitals" && (
        <Card className="rounded-[20px]"><CardLabel>Vitals (canonical)</CardLabel>
          <div className="mt-2 space-y-1">
            {w.vitals.length === 0 && <p className="text-[13px] text-text-tertiary">No vitals recorded. Record via the canonical vitals/flowsheet surface.</p>}
            {w.vitals.map((v) => <p key={v.id} className="text-[11.5px] text-text-tertiary">{new Date(v.recordedAt).toLocaleString()} — HR {v.heartRate ?? "—"} · BP {v.systolic ?? "—"}/{v.diastolic ?? "—"} · SpO2 {v.spo2 ?? "—"} · T {v.temperature ?? "—"}</p>)}
          </div>
        </Card>
      )}

      {tab === "diagnostics" && (
        <div className="grid gap-3 md:grid-cols-2">
          <Card className="rounded-[20px]"><CardLabel>Lab orders</CardLabel>
            <div className="mt-2 space-y-1">{w.labOrders.length === 0 && <p className="text-[12.5px] text-text-tertiary">None.</p>}
              {w.labOrders.map((o) => <p key={o.id} className="text-[12px]">{o.testName ?? o.panelName ?? "Lab"} · <span className="text-text-tertiary">{o.status}</span></p>)}
            </div>
          </Card>
          <Card className="rounded-[20px]"><CardLabel>Imaging orders</CardLabel>
            <div className="mt-2 space-y-1">{w.imagingOrders.length === 0 && <p className="text-[12.5px] text-text-tertiary">None.</p>}
              {w.imagingOrders.map((o) => <p key={o.id} className="text-[12px]">{o.modality ?? "Imaging"} {o.studyDescription ?? ""} · <span className="text-text-tertiary">{o.status}</span></p>)}
            </div>
          </Card>
          <Card className="rounded-[20px] md:col-span-2"><CardLabel>Medications</CardLabel>
            <div className="mt-2 space-y-1">{w.medicationOrders.length === 0 && <p className="text-[12.5px] text-text-tertiary">None.</p>}
              {w.medicationOrders.map((m) => <p key={m.id} className="flex items-center gap-1 text-[12px]"><Pill size={11} className="text-text-tertiary" /> {m.drugName} · <span className="text-text-tertiary">{m.status}</span></p>)}
            </div>
          </Card>
        </div>
      )}

      {tab === "reassess" && (
        <Card className="rounded-[20px]"><CardLabel>Reassessment</CardLabel>
          {!terminal && (
            <div className="mt-2 space-y-2">
              <textarea value={findings} onChange={(e) => setFindings(e.target.value)} placeholder="Findings on reassessment (recorded, never interpreted)" className="w-full rounded-lg border border-hairline bg-transparent px-2.5 py-1.5 text-[12.5px]" rows={2} />
              <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={escalate} onChange={(e) => setEscalate(e.target.checked)} /> Escalation required (recorded flag)</label>
              <button disabled={!findings} onClick={() => post(`/api/hospital/ed/encounters/${encounterId}/reassessment`, { findings, escalationRequired: escalate }, "Reassessment recorded.").then((ok) => { if (ok) { setFindings(""); setEscalate(false); } })} className="rounded-lg border border-cyan/40 bg-cyan/5 px-3 py-1.5 text-[12px] text-cyan disabled:opacity-40">Record reassessment</button>
            </div>
          )}
          <div className="mt-3 space-y-1.5">
            {w.edReassessments.map((r) => (
              <div key={r.id} className="rounded-xl border border-hairline px-3 py-2 text-[12px]">
                <div className="flex items-center justify-between"><span>{r.findings ?? "Reassessment"}</span>{r.escalationRequired && <StatusPill label="ESCALATE" tone="red" className="rounded-md" />}</div>
                <p className="text-[10.5px] text-text-tertiary">{new Date(r.createdAt).toLocaleString()}</p>
              </div>
            ))}
          </div>
        </Card>
      )}

      {tab === "timeline" && (
        <Card className="rounded-[20px]"><CardLabel>Timeline</CardLabel>
          {!timeline && <div className="mt-3 h-24 animate-pulse rounded-xl bg-black/[0.04]" />}
          {timeline && timeline.length === 0 && <p className="mt-2 text-[13px] text-text-tertiary">No events.</p>}
          <div className="mt-3 space-y-2">
            {timeline?.map((e) => (
              <div key={e.id} className="flex gap-2 text-[12.5px]">
                <span className="w-36 shrink-0 text-text-tertiary">{new Date(e.timestamp).toLocaleString()}</span>
                <span className="font-medium">{e.type}</span>
                <span className="text-text-secondary">{e.summary}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {tab === "disposition" && (
        <Card className="rounded-[20px]"><CardLabel>Disposition</CardLabel>
          {w.edDisposition ? (
            <p className="mt-2 text-[13px]">Dispositioned: <StatusPill label={w.edDisposition.type.replace(/_/g, " ")} tone="emerald" className="rounded-md" /> {w.edDisposition.reason ? `· ${w.edDisposition.reason}` : ""}</p>
          ) : terminal ? (
            <p className="mt-2 text-[13px] text-text-tertiary">Encounter is closed.</p>
          ) : (
            <div className="mt-2 space-y-2">
              <select value={dispType} onChange={(e) => setDispType(e.target.value)} className="w-full rounded-lg border border-hairline bg-transparent px-2 py-1.5 text-[12.5px]">
                {DISPOSITIONS.map((d) => <option key={d} value={d}>{d.replace(/_/g, " ")}</option>)}
              </select>
              {(dispType === "ADMIT_WARD" || dispType === "ADMIT_ICU") && (
                <input value={dispBed} onChange={(e) => setDispBed(e.target.value)} placeholder="Destination bed ID" className="w-full rounded-lg border border-hairline bg-transparent px-2 py-1.5 text-[12.5px]" />
              )}
              <input value={dispReason} onChange={(e) => setDispReason(e.target.value)} placeholder="Reason / note" className="w-full rounded-lg border border-hairline bg-transparent px-2 py-1.5 text-[12.5px]" />
              <button
                onClick={() => post(`/api/hospital/ed/encounters/${encounterId}/disposition`, { type: dispType, reason: dispReason || undefined, bedId: dispBed || undefined }, "Disposition recorded.")}
                className="rounded-lg border border-red/40 bg-red/5 px-3 py-1.5 text-[12.5px] text-red"
              >Record disposition</button>
              <p className="text-[11px] text-text-tertiary">Recording a death is restricted to authorized clinicians. Admit routes through canonical ADT.</p>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
