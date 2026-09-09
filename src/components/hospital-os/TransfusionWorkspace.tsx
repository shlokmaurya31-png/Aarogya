"use client";

import { useCallback, useEffect, useState } from "react";
import { Droplet, ShieldCheck, AlertTriangle, History, FlaskConical } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";

interface Unit { id: string; unitNumber: string; aboGroup: string | null; rhStatus: string | null; status: string; expiresAt: string | null; recalled: boolean }
interface Workspace {
  request: {
    id: string; facilityId: string; patientId: string; encounterId: string; productName: string; quantity: number; priority: string; status: string;
    indication: string | null; emergencyRelease: boolean; emergencyReason: string | null;
    patient: { fullName: string; uhid: string; sex: string; ageYears: number | null };
    compatibilityTests: { id: string; unitId: string | null; status: string; crossmatchResult: string | null; verifiedByStaffId: string | null; unit: Unit | null }[];
    reservations: { id: string; status: string; unit: Unit }[];
    issues: { id: string; status: string; unit: Unit; emergencyRelease: boolean }[];
    transfusions: {
      id: string; status: string; startedAt: string | null; endedAt: string | null; unit: Unit;
      observations: { id: string; observationType: string; value: string; recordedAt: string }[];
      reactions: { id: string; status: string; symptoms: string | null; reportedAt: string }[];
    }[];
  };
  location: { bed: { label: string; ward: { name: string } } | null } | null;
  notes: { id: string; type: string; status: string; createdAt: string }[];
}

const STATUS_TONE: Record<string, "emerald" | "amber" | "red" | "cyan" | "neutral"> = {
  REQUESTED: "neutral", REVIEWED: "amber", APPROVED: "cyan", COMPATIBILITY_PENDING: "amber", READY: "cyan", ISSUED: "amber", COMPLETED: "emerald", CANCELLED: "red", REJECTED: "red",
  IN_PROGRESS: "amber", PAUSED: "amber", STOPPED: "red", AVAILABLE: "emerald", RESERVED: "cyan", TRANSFUSING: "amber", TRANSFUSED: "neutral", QUARANTINED: "red",
};

const CHECKS = [
  ["patientIdentityVerified", "Patient identity"],
  ["unitIdentityVerified", "Unit identifier"],
  ["productVerified", "Product"],
  ["bloodGroupReviewed", "Blood group result"],
  ["compatibilityReviewed", "Compatibility status"],
  ["expiryReviewed", "Expiry"],
] as const;

export function TransfusionWorkspace({ requestId }: { requestId: string }) {
  const push = useToastStore((s) => s.push);
  const [data, setData] = useState<Workspace | null>(null);
  const [tab, setTab] = useState<"overview" | "bedside" | "transfusion" | "timeline">("overview");
  const [timeline, setTimeline] = useState<{ id: string; timestamp: string; type: string; summary: string }[] | null>(null);
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [bedsideUnit, setBedsideUnit] = useState("");
  const [obsType, setObsType] = useState("TEMPERATURE"); const [obsValue, setObsValue] = useState("");

  const load = useCallback(() => {
    fetch(`/api/hospital/blood/requests/${requestId}`).then((r) => r.json()).then((d) => { if (!d.error) setData(d.workspace); });
  }, [requestId]);
  useEffect(load, [load]);

  async function post(url: string, body: unknown, ok: string) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return false; }
    push(ok, "emerald"); load(); return true;
  }
  async function loadTimeline() {
    setTimeline(null);
    const d = await fetch(`/api/hospital/blood/requests/${requestId}/timeline`).then((r) => r.json());
    setTimeline(d.timeline ?? []);
  }

  if (!data) return <div className="mx-auto max-w-5xl animate-pulse"><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;
  const r = data.request;
  const issuedUnits = r.issues.filter((i) => i.status !== "RETURNED").map((i) => i.unit);
  const allChecked = CHECKS.every(([k]) => checks[k]);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <ToastViewport />

      {/* Patient safety header — identity is always prominent */}
      <Card className="rounded-[20px] border-red/20">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <Droplet size={18} className="mt-0.5 text-red" />
            <div>
              <p className="text-[18px] font-semibold leading-tight">{r.patient.fullName}</p>
              <p className="text-[12px] text-text-tertiary">UHID {r.patient.uhid} · {r.patient.sex}{r.patient.ageYears != null ? ` · ${r.patient.ageYears}y` : ""}{data.location?.bed ? ` · ${data.location.bed.ward.name} / ${data.location.bed.label}` : ""}</p>
              <p className="mt-1 text-[13px]">{r.productName} · {r.quantity} unit(s){r.indication ? ` · ${r.indication}` : ""}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {r.emergencyRelease && <StatusPill label="EMERGENCY RELEASE" tone="red" className="rounded-md" />}
            {r.priority !== "ROUTINE" && <StatusPill label={r.priority} tone={r.priority === "EMERGENCY" ? "red" : "amber"} className="rounded-md" />}
            <StatusPill label={r.status.replace(/_/g, " ")} tone={STATUS_TONE[r.status] ?? "neutral"} className="rounded-md" />
          </div>
        </div>
      </Card>

      {/* Tabs */}
      <div className="flex flex-wrap gap-1.5">
        {([["overview", "Overview", FlaskConical], ["bedside", "Bedside", ShieldCheck], ["transfusion", "Transfusion", Droplet], ["timeline", "Timeline", History]] as const).map(([t, label, Icon]) => (
          <button key={t} onClick={() => { setTab(t); if (t === "timeline") loadTimeline(); }} className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] ${tab === t ? "border-red/40 bg-red/5 text-red" : "border-hairline text-text-secondary hover:border-hairline-strong"}`}>
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="space-y-3">
          <Card className="rounded-[20px]">
            <CardLabel>Compatibility</CardLabel>
            <div className="mt-2 space-y-1.5">
              {r.compatibilityTests.length === 0 && <p className="text-[13px] text-text-tertiary">No compatibility testing recorded. A verified COMPATIBLE crossmatch (or an authorized emergency release) is required before a unit can be issued.</p>}
              {r.compatibilityTests.map((t) => (
                <div key={t.id} className="flex flex-wrap items-center justify-between gap-2 text-[12.5px]">
                  <span>{t.unit ? `Unit ${t.unit.unitNumber}` : "Type & screen"}{t.crossmatchResult ? ` · ${t.crossmatchResult}` : ""}</span>
                  <span className="flex items-center gap-1.5">
                    <StatusPill label={t.status} tone={t.status === "COMPATIBLE" ? "emerald" : t.status === "INCOMPATIBLE" ? "red" : "amber"} className="rounded-md" />
                    {t.status === "COMPATIBLE" && !t.verifiedByStaffId && (
                      <button onClick={() => post(`/api/hospital/blood/compatibility/${t.id}/verify`, {}, "Compatibility verified.")} className="rounded-md border border-hairline-strong px-2 py-0.5 text-[11px] hover:border-emerald/40 hover:text-emerald">Verify</button>
                    )}
                    {t.verifiedByStaffId && <StatusPill label="VERIFIED" tone="emerald" className="rounded-md" />}
                  </span>
                </div>
              ))}
            </div>
          </Card>

          <Card className="rounded-[20px]">
            <CardLabel>Reserved &amp; issued units</CardLabel>
            <div className="mt-2 space-y-1.5">
              {r.reservations.filter((x) => x.status === "ACTIVE").map((x) => (
                <div key={x.id} className="flex items-center justify-between text-[12.5px]">
                  <span>Unit {x.unit.unitNumber} · {x.unit.aboGroup ?? "?"}{x.unit.rhStatus === "POSITIVE" ? "+" : x.unit.rhStatus === "NEGATIVE" ? "−" : ""}</span>
                  <StatusPill label="RESERVED" tone="cyan" className="rounded-md" />
                </div>
              ))}
              {r.issues.map((i) => (
                <div key={i.id} className="flex flex-wrap items-center justify-between gap-2 text-[12.5px]">
                  <span>Unit {i.unit.unitNumber} · {i.unit.aboGroup ?? "?"}{i.unit.rhStatus === "POSITIVE" ? "+" : i.unit.rhStatus === "NEGATIVE" ? "−" : ""}</span>
                  <span className="flex items-center gap-1.5">
                    <StatusPill label={i.status} tone={STATUS_TONE[i.status] ?? "amber"} className="rounded-md" />
                    {(i.status === "ISSUED" || i.status === "IN_TRANSIT") && <button onClick={() => post(`/api/hospital/blood/issues/${i.id}`, { action: "receive" }, "Unit received.")} className="rounded-md border border-hairline-strong px-2 py-0.5 text-[11px] hover:border-cyan/40 hover:text-cyan">Receive</button>}
                    {i.status !== "RETURNED" && <button onClick={() => post(`/api/hospital/blood/issues/${i.id}`, { action: "return", reason: "Unused – returned to blood bank" }, "Unit returned.")} className="rounded-md border border-hairline-strong px-2 py-0.5 text-[11px] hover:border-amber/40 hover:text-amber">Return</button>}
                  </span>
                </div>
              ))}
              {r.reservations.filter((x) => x.status === "ACTIVE").length === 0 && r.issues.length === 0 && <p className="text-[13px] text-text-tertiary">No reserved or issued units.</p>}
            </div>
          </Card>
        </div>
      )}

      {tab === "bedside" && (
        <Card className="rounded-[20px]">
          <CardLabel>Bedside verification &amp; start</CardLabel>
          <p className="mt-1 text-[12px] text-text-tertiary">Documentation support for your institutional bedside check — every item must be confirmed before starting. This does not replace institutional two-person policy.</p>
          <div className="mt-3 space-y-1.5">
            {CHECKS.map(([k, label]) => (
              <label key={k} className="flex items-center gap-2 text-[13px]">
                <input type="checkbox" checked={!!checks[k]} onChange={(e) => setChecks((c) => ({ ...c, [k]: e.target.checked }))} />
                <span>{label}</span>
              </label>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select value={bedsideUnit} onChange={(e) => setBedsideUnit(e.target.value)} className="rounded-lg border border-hairline bg-transparent px-2.5 py-1.5 text-[12.5px]">
              <option value="">Select a received unit…</option>
              {issuedUnits.map((u) => <option key={u.id} value={u.id}>Unit {u.unitNumber} · {u.aboGroup ?? "?"}</option>)}
            </select>
            <button
              disabled={!allChecked || !bedsideUnit}
              onClick={() => post(`/api/hospital/blood/requests/${requestId}/transfusion`, { unitId: bedsideUnit, ...checks }, "Transfusion started.")}
              className="rounded-lg border border-red/40 bg-red/5 px-3 py-1.5 text-[12.5px] text-red disabled:opacity-40"
            >Start transfusion</button>
          </div>
          {!allChecked && <p className="mt-2 flex items-center gap-1 text-[11.5px] text-amber"><AlertTriangle size={12} /> All checks must be confirmed to start.</p>}
        </Card>
      )}

      {tab === "transfusion" && (
        <div className="space-y-3">
          {r.transfusions.length === 0 && <Card className="rounded-[20px]"><p className="text-[13px] text-text-tertiary">No transfusion started yet. Complete bedside verification to begin.</p></Card>}
          {r.transfusions.map((t) => (
            <Card key={t.id} className="rounded-[20px]">
              <div className="flex items-center justify-between">
                <p className="text-[13.5px] font-medium">Unit {t.unit.unitNumber}</p>
                <StatusPill label={t.status.replace(/_/g, " ")} tone={STATUS_TONE[t.status] ?? "neutral"} className="rounded-md" />
              </div>
              {(t.status === "IN_PROGRESS" || t.status === "PAUSED") && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {t.status === "IN_PROGRESS" && <button onClick={() => post(`/api/hospital/blood/transfusions/${t.id}`, { action: "status", to: "PAUSED" }, "Paused.")} className="rounded-md border border-hairline-strong px-2.5 py-1 text-[11px] hover:border-amber/40">Pause</button>}
                  {t.status === "PAUSED" && <button onClick={() => post(`/api/hospital/blood/transfusions/${t.id}`, { action: "status", to: "IN_PROGRESS" }, "Resumed.")} className="rounded-md border border-hairline-strong px-2.5 py-1 text-[11px] hover:border-cyan/40">Resume</button>}
                  <button onClick={() => post(`/api/hospital/blood/transfusions/${t.id}`, { action: "status", to: "COMPLETED" }, "Completed.")} className="rounded-md border border-hairline-strong px-2.5 py-1 text-[11px] hover:border-emerald/40 hover:text-emerald">Complete</button>
                  <button onClick={() => post(`/api/hospital/blood/transfusions/${t.id}`, { action: "status", to: "STOPPED", reason: "Stopped at bedside" }, "Stopped.")} className="rounded-md border border-hairline-strong px-2.5 py-1 text-[11px] hover:border-red/40 hover:text-red">Stop</button>
                  <button onClick={() => post(`/api/hospital/blood/transfusions/${t.id}`, { action: "reaction", symptoms: "Reported at bedside" }, "Reaction reported — unit quarantined.")} className="flex items-center gap-1 rounded-md border border-red/40 px-2.5 py-1 text-[11px] text-red"><AlertTriangle size={11} /> Report reaction</button>
                </div>
              )}
              {(t.status === "IN_PROGRESS" || t.status === "PAUSED") && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <select value={obsType} onChange={(e) => setObsType(e.target.value)} className="rounded-lg border border-hairline bg-transparent px-2 py-1 text-[12px]">
                    {["TEMPERATURE", "PULSE", "BP", "RR", "SPO2", "NOTE"].map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                  <input value={obsValue} onChange={(e) => setObsValue(e.target.value)} placeholder="value" className="w-28 rounded-lg border border-hairline bg-transparent px-2 py-1 text-[12px]" />
                  <button disabled={!obsValue} onClick={() => post(`/api/hospital/blood/transfusions/${t.id}`, { action: "observation", observationType: obsType, value: obsValue }, "Observation recorded.").then((ok) => ok && setObsValue(""))} className="rounded-md border border-hairline-strong px-2.5 py-1 text-[11px] disabled:opacity-40">Record</button>
                </div>
              )}
              {t.observations.length > 0 && (
                <div className="mt-2 space-y-1">
                  {t.observations.map((o) => <p key={o.id} className="text-[11.5px] text-text-tertiary">{new Date(o.recordedAt).toLocaleTimeString()} · {o.observationType}: {o.value}</p>)}
                </div>
              )}
              {t.reactions.map((rx) => (
                <div key={rx.id} className="mt-2 flex items-center justify-between rounded-lg border border-red/20 bg-red/5 px-2.5 py-1.5 text-[12px] text-red">
                  <span>Reaction reported{rx.symptoms ? ` · ${rx.symptoms}` : ""}</span>
                  <StatusPill label={rx.status.replace(/_/g, " ")} tone="red" className="rounded-md" />
                </div>
              ))}
            </Card>
          ))}
        </div>
      )}

      {tab === "timeline" && (
        <Card className="rounded-[20px]">
          <CardLabel>Timeline</CardLabel>
          {!timeline && <div className="mt-3 h-24 animate-pulse rounded-xl bg-black/[0.04]" />}
          {timeline && timeline.length === 0 && <p className="mt-2 text-[13px] text-text-tertiary">No events yet.</p>}
          <div className="mt-3 space-y-2">
            {timeline?.map((e) => (
              <div key={e.id} className="flex gap-2 text-[12.5px]">
                <span className="w-32 shrink-0 text-text-tertiary">{new Date(e.timestamp).toLocaleString()}</span>
                <span className="font-medium">{e.type}</span>
                <span className="text-text-secondary">{e.summary}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
