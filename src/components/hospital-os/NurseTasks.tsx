"use client";

import { useEffect, useState } from "react";
import { Pill, Activity, Check, Users, Send, X } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";

interface MedTask { administrationId: string; medicationOrderId: string; patientName: string; bedLabel: string; drug: string; dose: string; route: string; scheduledAt: string; isControlled?: boolean }
interface VitalTask { encounterId: string; patientName: string; bedLabel: string; lastRecordedAt: string | null }
interface Dashboard {
  assignedPatients: { assignmentId: string; patientId: string; patientName: string; uhid: string; bedLabel: string | null; wardName: string | null; encounterId: string | null }[];
  overdueTasks: number; pendingTasks: number; medicationsDue: number; missedAdministrations: number; upcomingAdministrations: number; pendingHandoffs: number;
}

export function NurseTasks({ staffId }: { staffId?: string }) {
  const push = useToastStore((s) => s.push);
  const [medTasks, setMedTasks] = useState<MedTask[] | null>(null);
  const [vitalTasks, setVitalTasks] = useState<VitalTask[] | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [adminFor, setAdminFor] = useState<MedTask | null>(null);
  const [witnessStaffId, setWitnessStaffId] = useState("");
  const [checksConfirmed, setChecksConfirmed] = useState(false);

  function load() {
    fetch("/api/hospital/nurse/tasks").then((r) => r.json()).then((d) => {
      setMedTasks(d.medicationTasks ?? []);
      setVitalTasks(d.vitalsTasks ?? []);
    });
    fetch(`/api/hospital/nurse/dashboard${staffId ? `?staffId=${staffId}` : ""}`).then((r) => r.json()).then(setDashboard);
  }
  useEffect(load, [staffId]);

  async function administer(orderId: string, administrationId: string, status: "GIVEN" | "HELD" | "REFUSED", isControlled?: boolean) {
    if (isControlled && status === "GIVEN" && !witnessStaffId.trim()) { push("Controlled medication requires a witness staff id.", "amber"); return; }
    let reasonCode: string | undefined;
    if (status !== "GIVEN") {
      reasonCode = window.prompt(`Reason for marking this ${status.toLowerCase()}?`) ?? undefined;
      if (!reasonCode) return;
    }
    const res = await fetch(`/api/hospital/orders/medication/${orderId}/administer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ administrationId, status, witnessStaffId: witnessStaffId || undefined, safetyChecksConfirmed: checksConfirmed, reasonCode }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push(status === "GIVEN" ? "Medication administered." : `Marked ${status.toLowerCase()}.`, status === "GIVEN" ? "emerald" : "amber");
    setAdminFor(null); setWitnessStaffId(""); setChecksConfirmed(false);
    load();
  }

  async function recordVital(encounterId: string) {
    const res = await fetch(`/api/hospital/encounters/${encounterId}/vitals`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hr: 78, sbp: 120, dbp: 80, rr: 16, spo2: 97, tempC: 37.0 }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    const data = await res.json();
    if (data.abnormal?.length) push(`Vitals recorded — ${data.abnormal.length} out of configured range.`, "amber");
    else push("Vitals recorded.", "emerald");
    load();
  }

  async function requestHandoff(patientId: string, encounterId: string | null) {
    const summary = window.prompt("Handoff summary?");
    if (!summary) return;
    const res = await fetch("/api/hospital/handoffs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patientId, encounterId: encounterId ?? undefined, type: "NURSE", summary }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push("Handoff created.", "emerald");
    load();
  }

  if (!medTasks || !vitalTasks) return <div className="mx-auto max-w-5xl animate-pulse"><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;

  return (
    <div className="mx-auto max-w-5xl">
      <ToastViewport />
      <h1 className="text-[20px] font-semibold tracking-tight">My Shift</h1>
      <p className="mt-1 text-[13px] text-text-secondary">{medTasks.length} medications due · {vitalTasks.length} vitals due.</p>

      {dashboard && (
        <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-6">
          {[
            ["Overdue tasks", dashboard.overdueTasks],
            ["Pending tasks", dashboard.pendingTasks],
            ["Meds due", dashboard.medicationsDue],
            ["Missed doses", dashboard.missedAdministrations],
            ["Upcoming (2h)", dashboard.upcomingAdministrations],
            ["Handoffs", dashboard.pendingHandoffs],
          ].map(([label, value]) => (
            <Card key={label as string} className="rounded-lg p-2.5">
              <p className="text-[16px] font-semibold tabular-nums">{value}</p>
              <CardLabel className="mt-0.5 normal-case tracking-normal">{label}</CardLabel>
            </Card>
          ))}
        </div>
      )}

      {dashboard && dashboard.assignedPatients.length > 0 && (
        <Card className="mt-4 rounded-[20px]">
          <div className="flex items-center gap-2"><Users size={14} className="text-cyan" /><CardLabel>My assigned patients</CardLabel></div>
          <div className="mt-2.5 space-y-1.5">
            {dashboard.assignedPatients.map((p) => (
              <div key={p.assignmentId} className="flex items-center justify-between rounded-md border border-hairline px-3 py-1.5 text-[12px]">
                <span>{p.patientName} <span className="text-text-tertiary">· {p.uhid}{p.bedLabel ? ` · ${p.bedLabel} (${p.wardName})` : ""}</span></span>
                <button onClick={() => requestHandoff(p.patientId, p.encounterId)} className="flex items-center gap-1 rounded-md border border-hairline-strong px-2 py-0.5 text-[10.5px] hover:border-cyan/40 hover:text-cyan"><Send size={10} /> Handoff</button>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card className="rounded-[20px]">
          <div className="flex items-center gap-2"><Pill size={14} className="text-cyan" /><CardLabel>Medications due</CardLabel></div>
          <div className="mt-3 space-y-2.5">
            {medTasks.map((t) => (
              <div key={t.administrationId} className="rounded-lg border border-hairline p-3">
                <p className="text-[13px] font-medium">{t.patientName} <span className="font-normal text-text-tertiary">· Bed {t.bedLabel}</span></p>
                <p className="text-[12px] text-text-secondary">{t.drug} {t.dose} · {t.route}</p>

                {adminFor?.administrationId === t.administrationId ? (
                  <div className="mt-2 space-y-1.5 rounded-md bg-black/[0.02] p-2">
                    <label className="flex items-center gap-1.5 text-[11px]"><input type="checkbox" checked={checksConfirmed} onChange={(e) => setChecksConfirmed(e.target.checked)} /> Right patient / drug / dose / route / time confirmed</label>
                    <input value={witnessStaffId} onChange={(e) => setWitnessStaffId(e.target.value)} placeholder="Witness staff id (controlled meds)" className="w-full rounded-md border border-hairline bg-white px-2 py-1 text-[11px] outline-none" />
                    <div className="flex gap-1.5">
                      <button onClick={() => administer(t.medicationOrderId, t.administrationId, "GIVEN", t.isControlled)} disabled={!checksConfirmed} className="flex items-center gap-1 rounded-md bg-emerald px-2.5 py-1 text-[11px] font-medium text-white hover:brightness-110 disabled:opacity-40"><Check size={11} /> Give</button>
                      <button onClick={() => administer(t.medicationOrderId, t.administrationId, "HELD")} className="rounded-md border border-hairline-strong px-2.5 py-1 text-[11px] hover:border-amber/40 hover:text-amber">Hold</button>
                      <button onClick={() => administer(t.medicationOrderId, t.administrationId, "REFUSED")} className="rounded-md border border-hairline-strong px-2.5 py-1 text-[11px] hover:border-red/40 hover:text-red">Refused</button>
                      <button onClick={() => setAdminFor(null)} className="rounded-md border border-hairline-strong px-2 py-1 text-[11px]"><X size={11} /></button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => setAdminFor(t)} className="mt-2 flex items-center gap-1 rounded-md bg-emerald px-2.5 py-1 text-[11px] font-medium text-white hover:brightness-110">
                    <Check size={11} /> Administer
                  </button>
                )}
              </div>
            ))}
            {medTasks.length === 0 && <p className="text-[12.5px] text-text-tertiary">No medications due right now.</p>}
          </div>
        </Card>

        <Card className="rounded-[20px]">
          <div className="flex items-center gap-2"><Activity size={14} className="text-cyan" /><CardLabel>Vitals due</CardLabel></div>
          <div className="mt-3 space-y-2.5">
            {vitalTasks.map((t) => (
              <div key={t.encounterId} className="rounded-lg border border-hairline p-3">
                <p className="text-[13px] font-medium">{t.patientName} <span className="font-normal text-text-tertiary">· Bed {t.bedLabel}</span></p>
                <p className="text-[11.5px] text-text-tertiary">Last recorded: {t.lastRecordedAt ? new Date(t.lastRecordedAt).toLocaleTimeString() : "never"}</p>
                <button onClick={() => recordVital(t.encounterId)} className="mt-2 flex items-center gap-1 rounded-md bg-cyan px-2.5 py-1 text-[11px] font-medium text-ink hover:brightness-110">
                  <Check size={11} /> Record vitals
                </button>
              </div>
            ))}
            {vitalTasks.length === 0 && <p className="text-[12.5px] text-text-tertiary">No vitals due right now.</p>}
          </div>
        </Card>
      </div>
    </div>
  );
}
