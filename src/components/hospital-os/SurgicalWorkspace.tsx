"use client";

import { useEffect, useState, useCallback } from "react";
import { Scissors, ClipboardCheck, Users, Syringe, Activity, Boxes, TestTube, FileText, BedDouble, History } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";

interface Workspace {
  surgery: {
    id: string; facilityId: string; patientId: string; encounterId: string; procedureName: string; indication: string | null;
    laterality: string | null; urgency: string; status: string; surgeonStaffId: string | null; consentStatus: string | null;
    actualStart: string | null; actualEnd: string | null; operativeFindings: string | null; complications: string | null;
    estimatedBloodLossMl: number | null; recoveryDestination: string | null; operativeNoteId: string | null;
    patient: { fullName: string; uhid: string; sex: string; ageYears: number | null };
    procedure: { name: string; code: string } | null;
    schedule: { startAt: string; endAt: string; status: string; operatingTheatre: { name: string } } | null;
    team: { id: string; staffId: string; role: string }[];
    checklist: { id: string; phase: string; itemKey: string; label: string; checked: boolean }[];
    anesthesia: { type: string; status: string; anesthetistStaffId: string; startAt: string | null; endAt: string | null } | null;
    specimens: { id: string; specimenType: string; site: string | null; status: string; collectedAt: string }[];
    itemUsages: { id: string; usageType: string; itemId: string; quantity: number; serialNumber: string | null; stockConsumed: boolean }[];
    recovery: { status: string; destination: string | null; arrivalAt: string | null } | null;
  };
  notes: { id: string; type: string; status: string; author: { user: { displayName: string } }; createdAt: string }[];
  location: { bed: { label: string; ward: { name: string } } | null } | null;
  labs: { id: string; testName: string; results: { value: string; unit: string | null; isCritical: boolean }[] }[];
  imaging: { id: string; modality: string; studyDescription: string; reports: { impression: string }[] }[];
}

const TEAM_ROLES = ["SURGEON", "ASSISTANT_SURGEON", "ANESTHETIST", "ANESTHETIST_ASSISTANT", "SCRUB_NURSE", "CIRCULATING_NURSE", "TECHNICIAN"];
const STATUS_TONE: Record<string, "emerald" | "amber" | "red" | "cyan" | "neutral"> = { REQUESTED: "neutral", REVIEWED: "amber", APPROVED: "cyan", SCHEDULED: "cyan", IN_PROGRESS: "amber", COMPLETED: "emerald", CANCELLED: "red" };

export function SurgicalWorkspace({ surgeryId }: { surgeryId: string }) {
  const push = useToastStore((s) => s.push);
  const [data, setData] = useState<Workspace | null>(null);
  const [theatres, setTheatres] = useState<{ id: string; name: string }[]>([]);
  const [tab, setTab] = useState<"overview" | "checklist" | "team" | "anesthesia" | "procedure" | "items" | "specimens" | "note" | "recovery" | "timeline">("overview");
  const [timeline, setTimeline] = useState<{ id: string; timestamp: string; type: string; summary: string }[] | null>(null);

  const [schedOt, setSchedOt] = useState(""); const [schedStart, setSchedStart] = useState(""); const [schedEnd, setSchedEnd] = useState("");
  const [teamStaff, setTeamStaff] = useState(""); const [teamRole, setTeamRole] = useState("SURGEON");
  const [anesType, setAnesType] = useState("GENERAL");
  const [findings, setFindings] = useState(""); const [ebl, setEbl] = useState(""); const [recoveryDest, setRecoveryDest] = useState("PACU");
  const [itemId, setItemId] = useState(""); const [itemQty, setItemQty] = useState("1"); const [itemType, setItemType] = useState<"IMPLANT" | "CONSUMABLE">("IMPLANT"); const [itemSerial, setItemSerial] = useState("");
  const [specType, setSpecType] = useState(""); const [specSite, setSpecSite] = useState("");
  const [noteText, setNoteText] = useState("");

  const load = useCallback(() => {
    fetch(`/api/hospital/ot/surgeries/${surgeryId}`).then((r) => r.json()).then((d) => { if (!d.error) setData(d); });
  }, [surgeryId]);
  useEffect(load, [load]);
  useEffect(() => { fetch("/api/hospital/ot/theatres").then((r) => r.json()).then((d) => setTheatres(d.theatres ?? [])); }, []);

  async function post(url: string, body: unknown, ok: string, method = "POST") {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return false; }
    push(ok, "emerald"); load(); return true;
  }

  if (!data) return <div className="mx-auto max-w-5xl animate-pulse"><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;
  const s = data.surgery;

  async function loadTimeline() {
    setTimeline(null);
    const d = await fetch(`/api/hospital/ot/surgeries/${surgeryId}/timeline`).then((r) => r.json());
    setTimeline(d.entries ?? []);
  }

  const phases = ["BEFORE_INDUCTION", "BEFORE_INCISION", "BEFORE_LEAVING"];

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <ToastViewport />
      <Card className="rounded-[20px]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <Scissors size={18} className="mt-0.5 text-cyan" />
            <div>
              <h1 className="text-[20px] font-semibold tracking-tight">{s.procedureName}{s.laterality && s.laterality !== "NA" ? ` · ${s.laterality}` : ""}</h1>
              <p className="text-[12px] text-text-secondary">{s.patient.fullName} · {s.patient.uhid} · {s.patient.ageYears}{s.patient.sex[0]?.toUpperCase()}
                {s.schedule ? ` · ${s.schedule.operatingTheatre.name} · ${new Date(s.schedule.startAt).toLocaleString()}` : ""}
                {data.location?.bed ? ` · ${data.location.bed.ward.name} ${data.location.bed.label}` : ""}
              </p>
              {s.indication && <p className="mt-0.5 text-[11px] text-text-tertiary">Indication: {s.indication}</p>}
            </div>
          </div>
          <StatusPill label={s.status.replace("_", " ")} tone={STATUS_TONE[s.status] ?? "neutral"} className="rounded-md" />
        </div>
        {/* Lifecycle actions */}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {s.status === "REQUESTED" && <button onClick={() => post(`/api/hospital/ot/surgeries/${s.id}/status`, { to: "REVIEWED" }, "Reviewed.", "PATCH")} className="rounded-md border border-hairline-strong px-2.5 py-1 text-[11px] hover:border-cyan/40">Mark reviewed</button>}
          {s.status === "REVIEWED" && <button onClick={() => post(`/api/hospital/ot/surgeries/${s.id}/status`, { to: "APPROVED" }, "Approved.", "PATCH")} className="rounded-md border border-hairline-strong px-2.5 py-1 text-[11px] hover:border-emerald/40">Approve</button>}
          {s.status === "SCHEDULED" && <button onClick={() => post(`/api/hospital/ot/surgeries/${s.id}/start`, {}, "Procedure started.")} className="rounded-md bg-amber px-2.5 py-1 text-[11px] font-medium text-ink hover:brightness-110">Start procedure</button>}
          {(s.status === "REQUESTED" || s.status === "REVIEWED" || s.status === "APPROVED" || s.status === "SCHEDULED") && (
            <button onClick={() => { const reason = window.prompt("Cancellation reason?"); if (reason) post(`/api/hospital/ot/surgeries/${s.id}/status`, { to: "CANCELLED", reason }, "Cancelled.", "PATCH"); }} className="rounded-md border border-hairline-strong px-2.5 py-1 text-[11px] hover:border-red/40 hover:text-red">Cancel</button>
          )}
        </div>
      </Card>

      <div className="flex flex-wrap gap-2">
        {([["overview", "Overview"], ["checklist", "Checklist"], ["team", "Team"], ["anesthesia", "Anesthesia"], ["procedure", "Procedure"], ["items", "Implants/Consumables"], ["specimens", "Specimens"], ["note", "Operative Note"], ["recovery", "Recovery"], ["timeline", "Timeline"]] as const).map(([id, label]) => (
          <button key={id} onClick={() => { setTab(id); if (id === "timeline") loadTimeline(); }} className={`rounded-full px-3 py-1.5 text-[12px] ${tab === id ? "bg-cyan text-ink" : "border border-hairline text-text-secondary"}`}>{label}</button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card className="rounded-[20px]">
            <CardLabel>Pre-op & scheduling</CardLabel>
            <p className="mt-2 text-[12px]">Consent: {s.consentStatus ?? "not recorded"} · Checklist: {s.checklist.filter((c) => c.checked).length}/{s.checklist.length}</p>
            {s.status === "APPROVED" && (
              <div className="mt-2 space-y-1.5 rounded-md bg-black/[0.02] p-2">
                <p className="text-[10.5px] uppercase tracking-wide text-text-tertiary">Schedule into OT</p>
                <div className="flex gap-1.5">
                  <select value={schedOt} onChange={(e) => setSchedOt(e.target.value)} className="flex-1 rounded-md border border-hairline bg-white px-1.5 py-1 text-[11px] outline-none">
                    <option value="">Theatre...</option>{theatres.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
                <div className="flex gap-1.5">
                  <input type="datetime-local" value={schedStart} onChange={(e) => setSchedStart(e.target.value)} className="flex-1 rounded-md border border-hairline bg-white px-1.5 py-1 text-[11px] outline-none" />
                  <input type="datetime-local" value={schedEnd} onChange={(e) => setSchedEnd(e.target.value)} className="flex-1 rounded-md border border-hairline bg-white px-1.5 py-1 text-[11px] outline-none" />
                </div>
                <button onClick={() => { if (!schedOt || !schedStart || !schedEnd) { push("Theatre, start and end required.", "amber"); return; } post(`/api/hospital/ot/surgeries/${s.id}/schedule`, { operatingTheatreId: schedOt, startAt: new Date(schedStart).toISOString(), endAt: new Date(schedEnd).toISOString() }, "Scheduled."); }} className="rounded-md bg-cyan px-2.5 py-1 text-[11px] font-medium text-ink">Schedule</button>
              </div>
            )}
          </Card>
          <Card className="rounded-[20px]">
            <CardLabel>Diagnostics</CardLabel>
            <div className="mt-2 space-y-0.5">
              {data.labs.slice(0, 4).map((l) => <p key={l.id} className="text-[11px]">{l.testName}{l.results[0] ? `: ${l.results[0].value}${l.results[0].isCritical ? " ⚠" : ""}` : ""}</p>)}
              {data.imaging.slice(0, 3).map((im) => <p key={im.id} className="text-[11px] text-text-secondary">{im.modality}: {im.studyDescription}</p>)}
              {data.labs.length === 0 && data.imaging.length === 0 && <p className="text-[11px] text-text-tertiary">No diagnostics.</p>}
            </div>
          </Card>
        </div>
      )}

      {tab === "checklist" && (
        <Card className="rounded-[20px]">
          <div className="flex items-center gap-2"><ClipboardCheck size={14} className="text-cyan" /><CardLabel>Surgical safety checklist</CardLabel></div>
          {s.checklist.length === 0 && <p className="mt-2 text-[11.5px] text-text-tertiary">Loading checklist… (open once to seed the WHO-style template).</p>}
          {phases.map((phase) => (
            <div key={phase} className="mt-3">
              <p className="text-[10.5px] uppercase tracking-wide text-text-tertiary">{phase.replace(/_/g, " ")}</p>
              <div className="mt-1 space-y-1">
                {s.checklist.filter((c) => c.phase === phase).map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-[12px]">
                    <input type="checkbox" checked={c.checked} onChange={(e) => post(`/api/hospital/ot/surgeries/${s.id}/checklist`, { itemKey: c.itemKey, checked: e.target.checked }, "Checklist updated.", "PATCH")} />
                    {c.label}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </Card>
      )}

      {tab === "team" && (
        <Card className="rounded-[20px]">
          <div className="flex items-center gap-2"><Users size={14} className="text-cyan" /><CardLabel>Surgical team</CardLabel></div>
          <div className="mt-2 flex gap-1.5">
            <input value={teamStaff} onChange={(e) => setTeamStaff(e.target.value)} placeholder="Staff profile id" className="flex-1 rounded-md border border-hairline bg-white px-2 py-1 text-[11px] outline-none" />
            <select value={teamRole} onChange={(e) => setTeamRole(e.target.value)} className="rounded-md border border-hairline bg-white px-1.5 py-1 text-[11px] outline-none">{TEAM_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select>
            <button onClick={() => { if (!teamStaff.trim()) return; post(`/api/hospital/ot/surgeries/${s.id}/team`, { staffId: teamStaff.trim(), role: teamRole }, "Team member added."); setTeamStaff(""); }} className="rounded-md bg-cyan px-2 py-1 text-[11px] font-medium text-ink">Add</button>
          </div>
          <div className="mt-2 space-y-0.5">
            {s.team.map((m) => <p key={m.id} className="text-[11.5px]">{m.role}: {m.staffId}</p>)}
            {s.team.length === 0 && <p className="text-[11px] text-text-tertiary">No team recorded.</p>}
          </div>
        </Card>
      )}

      {tab === "anesthesia" && (
        <Card className="rounded-[20px]">
          <div className="flex items-center gap-2"><Syringe size={14} className="text-cyan" /><CardLabel>Anesthesia</CardLabel></div>
          {s.anesthesia && <p className="mt-2 text-[12px]">Current: {s.anesthesia.type} · {s.anesthesia.status}</p>}
          <div className="mt-2 flex gap-1.5">
            <select value={anesType} onChange={(e) => setAnesType(e.target.value)} className="rounded-md border border-hairline bg-white px-1.5 py-1 text-[11px] outline-none">{["GENERAL", "REGIONAL", "LOCAL", "SEDATION", "OTHER"].map((t) => <option key={t} value={t}>{t}</option>)}</select>
            <button onClick={() => post(`/api/hospital/ot/surgeries/${s.id}/anesthesia`, { type: anesType, status: "IN_PROGRESS", startAt: new Date().toISOString() }, "Anesthesia recorded.")} className="rounded-md bg-cyan px-2 py-1 text-[11px] font-medium text-ink">Record / start</button>
            {s.anesthesia?.status === "IN_PROGRESS" && <button onClick={() => post(`/api/hospital/ot/surgeries/${s.id}/anesthesia`, { type: s.anesthesia!.type, status: "COMPLETED", endAt: new Date().toISOString() }, "Anesthesia completed.")} className="rounded-md border border-hairline-strong px-2 py-1 text-[11px]">Complete</button>}
          </div>
          <p className="mt-2 text-[10.5px] text-text-tertiary">Observations/dosing are recorded, not recommended — no anesthetic decision support.</p>
        </Card>
      )}

      {tab === "procedure" && (
        <Card className="rounded-[20px]">
          <div className="flex items-center gap-2"><Activity size={14} className="text-cyan" /><CardLabel>Procedure execution</CardLabel></div>
          {s.actualStart && <p className="mt-2 text-[11.5px] text-text-tertiary">Started {new Date(s.actualStart).toLocaleString()}{s.actualEnd ? ` · Ended ${new Date(s.actualEnd).toLocaleString()}` : ""}</p>}
          {s.status === "IN_PROGRESS" && (
            <div className="mt-2 space-y-1.5">
              <textarea value={findings} onChange={(e) => setFindings(e.target.value)} rows={3} placeholder="Operative findings / details" className="w-full rounded-md border border-hairline bg-white px-2 py-1 text-[12px] outline-none" />
              <div className="flex gap-1.5">
                <input value={ebl} onChange={(e) => setEbl(e.target.value)} type="number" placeholder="EBL (mL)" className="w-24 rounded-md border border-hairline bg-white px-2 py-1 text-[11px] outline-none" />
                <select value={recoveryDest} onChange={(e) => setRecoveryDest(e.target.value)} className="rounded-md border border-hairline bg-white px-1.5 py-1 text-[11px] outline-none">{["PACU", "ICU", "WARD"].map((d) => <option key={d} value={d}>{d}</option>)}</select>
                <button onClick={() => post(`/api/hospital/ot/surgeries/${s.id}/complete`, { operativeFindings: findings || undefined, estimatedBloodLossMl: ebl ? Number(ebl) : undefined, recoveryDestination: recoveryDest }, "Procedure completed.")} className="rounded-md bg-emerald px-2.5 py-1 text-[11px] font-medium text-white">Complete procedure</button>
              </div>
            </div>
          )}
          {s.status === "COMPLETED" && <p className="mt-2 text-[12px]">Findings: {s.operativeFindings ?? "—"} · EBL: {s.estimatedBloodLossMl ?? "—"}mL · Recovery: {s.recoveryDestination ?? "—"}</p>}
          {s.status !== "IN_PROGRESS" && s.status !== "COMPLETED" && <p className="mt-2 text-[11.5px] text-text-tertiary">Start the procedure (from the header) once scheduled.</p>}
        </Card>
      )}

      {tab === "items" && (
        <Card className="rounded-[20px]">
          <div className="flex items-center gap-2"><Boxes size={14} className="text-cyan" /><CardLabel>Implants & consumables</CardLabel></div>
          <p className="mt-1 text-[10.5px] text-text-tertiary">Uses canonical inventory. Provide a stock location id to transactionally consume from stock (over-issue-safe); otherwise the usage is recorded without stock consumption.</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <select value={itemType} onChange={(e) => setItemType(e.target.value as "IMPLANT" | "CONSUMABLE")} className="rounded-md border border-hairline bg-white px-1.5 py-1 text-[11px] outline-none"><option value="IMPLANT">IMPLANT</option><option value="CONSUMABLE">CONSUMABLE</option></select>
            <input value={itemId} onChange={(e) => setItemId(e.target.value)} placeholder="Item id" className="flex-1 rounded-md border border-hairline bg-white px-2 py-1 text-[11px] outline-none" />
            <input value={itemQty} onChange={(e) => setItemQty(e.target.value)} type="number" placeholder="Qty" className="w-16 rounded-md border border-hairline bg-white px-2 py-1 text-[11px] outline-none" />
            {itemType === "IMPLANT" && <input value={itemSerial} onChange={(e) => setItemSerial(e.target.value)} placeholder="Serial" className="w-28 rounded-md border border-hairline bg-white px-2 py-1 text-[11px] outline-none" />}
            <button onClick={() => { if (!itemId.trim()) return; post(`/api/hospital/ot/surgeries/${s.id}/item-usage`, { usageType: itemType, itemId: itemId.trim(), quantity: Number(itemQty), serialNumber: itemSerial || undefined }, "Item usage recorded."); setItemId(""); setItemSerial(""); }} className="rounded-md bg-cyan px-2 py-1 text-[11px] font-medium text-ink">Record</button>
          </div>
          <div className="mt-2 space-y-0.5">
            {s.itemUsages.map((u) => <p key={u.id} className="text-[11.5px]">{u.usageType}: {u.itemId} x{u.quantity}{u.serialNumber ? ` · SN ${u.serialNumber}` : ""}{u.stockConsumed ? " · stock consumed" : ""}</p>)}
            {s.itemUsages.length === 0 && <p className="text-[11px] text-text-tertiary">None recorded.</p>}
          </div>
        </Card>
      )}

      {tab === "specimens" && (
        <Card className="rounded-[20px]">
          <div className="flex items-center gap-2"><TestTube size={14} className="text-cyan" /><CardLabel>Specimens</CardLabel></div>
          <div className="mt-2 flex gap-1.5">
            <input value={specType} onChange={(e) => setSpecType(e.target.value)} placeholder="Specimen type" className="flex-1 rounded-md border border-hairline bg-white px-2 py-1 text-[11px] outline-none" />
            <input value={specSite} onChange={(e) => setSpecSite(e.target.value)} placeholder="Site" className="w-28 rounded-md border border-hairline bg-white px-2 py-1 text-[11px] outline-none" />
            <button onClick={() => { if (!specType.trim()) return; post(`/api/hospital/ot/surgeries/${s.id}/specimens`, { specimenType: specType.trim(), site: specSite || undefined }, "Specimen collected."); setSpecType(""); setSpecSite(""); }} className="rounded-md bg-cyan px-2 py-1 text-[11px] font-medium text-ink">Collect</button>
          </div>
          <div className="mt-2 space-y-0.5">
            {s.specimens.map((sp) => <p key={sp.id} className="text-[11.5px]">{sp.specimenType}{sp.site ? ` (${sp.site})` : ""} · {sp.status} · {new Date(sp.collectedAt).toLocaleString()}</p>)}
            {s.specimens.length === 0 && <p className="text-[11px] text-text-tertiary">None collected.</p>}
          </div>
        </Card>
      )}

      {tab === "note" && (
        <Card className="rounded-[20px]">
          <div className="flex items-center gap-2"><FileText size={14} className="text-cyan" /><CardLabel>Operative note</CardLabel></div>
          <p className="mt-1 text-[10.5px] text-text-tertiary">Records pre/post-op diagnosis, procedure, findings, technique, specimens, implants, blood loss, complications, disposition. Signed notes are immutable (amend via patient chart).</p>
          <textarea value={noteText} onChange={(e) => setNoteText(e.target.value)} rows={6} placeholder="Operative note..." className="mt-2 w-full rounded-md border border-hairline bg-black/[0.02] px-3 py-2 text-[13px] outline-none focus:border-cyan/40" />
          <button onClick={() => { if (!noteText.trim()) { push("Enter note content.", "amber"); return; } post(`/api/hospital/encounters/${s.encounterId}/notes`, { type: "OPERATIVE", content: { assessment: noteText.trim() }, sign: true }, "Operative note signed."); setNoteText(""); }} className="mt-2 rounded-md bg-cyan px-4 py-1.5 text-[12.5px] font-medium text-ink">Sign &amp; save</button>
          <div className="mt-3 space-y-1">
            {data.notes.map((n) => <p key={n.id} className="text-[11px] text-text-tertiary">{n.type} · {n.author.user.displayName} · {n.status} · {new Date(n.createdAt).toLocaleString()}</p>)}
          </div>
        </Card>
      )}

      {tab === "recovery" && (
        <Card className="rounded-[20px]">
          <div className="flex items-center gap-2"><BedDouble size={14} className="text-cyan" /><CardLabel>PACU / Recovery</CardLabel></div>
          <p className="mt-2 text-[12px]">Status: {s.recovery?.status ?? "not started"}{s.recovery?.destination ? ` · ${s.recovery.destination}` : ""}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(!s.recovery || s.recovery.status === "PENDING") && <button onClick={() => post(`/api/hospital/ot/surgeries/${s.id}/recovery`, { status: "IN_RECOVERY", destination: s.recoveryDestination ?? "PACU" }, "In recovery.", "PATCH")} className="rounded-md bg-cyan px-2.5 py-1 text-[11px] font-medium text-ink">Arrive in recovery</button>}
            {s.recovery?.status === "IN_RECOVERY" && <button onClick={() => post(`/api/hospital/ot/surgeries/${s.id}/recovery`, { status: "READY_FOR_TRANSFER" }, "Ready for transfer.", "PATCH")} className="rounded-md border border-hairline-strong px-2.5 py-1 text-[11px]">Mark ready for transfer</button>}
            {s.recovery?.status === "READY_FOR_TRANSFER" && <button onClick={() => post(`/api/hospital/ot/surgeries/${s.id}/recovery`, { status: "TRANSFERRED" }, "Transferred out.", "PATCH")} className="rounded-md bg-emerald px-2.5 py-1 text-[11px] font-medium text-white">Mark transferred</button>}
          </div>
          <p className="mt-2 text-[10.5px] text-text-tertiary">&ldquo;Ready&rdquo;/&ldquo;Transferred&rdquo; are workflow statuses — not autonomous medical clearance. Physical ward/ICU movement uses the ADT Transfers workspace.</p>
        </Card>
      )}

      {tab === "timeline" && (
        <Card className="rounded-[20px]">
          <div className="flex items-center gap-2"><History size={14} className="text-cyan" /><CardLabel>Surgical timeline</CardLabel></div>
          <div className="mt-3 space-y-1.5">
            {timeline === null && <p className="text-[12px] text-text-tertiary">Loading...</p>}
            {timeline?.map((t) => (
              <div key={t.id} className="flex gap-3 text-[11.5px]">
                <span className="w-40 shrink-0 text-[10.5px] text-text-tertiary">{new Date(t.timestamp).toLocaleString()}</span>
                <span><span className="font-medium">{t.type}:</span> {t.summary}</span>
              </div>
            ))}
            {timeline?.length === 0 && <p className="text-[12px] text-text-tertiary">No events yet.</p>}
          </div>
        </Card>
      )}
    </div>
  );
}
