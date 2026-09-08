"use client";

import { useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { ClipboardList, Activity, Droplet, ListChecks, HeartPulse, Send, Inbox, FileText, Pill, History } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { HandoffComposer } from "@/components/hospital-os/shared/HandoffComposer";
import { HandoffInbox } from "@/components/hospital-os/shared/HandoffInbox";

const FINDING_SECTIONS: { key: string; label: string }[] = [
  { key: "general", label: "General appearance" },
  { key: "neuro", label: "Neurological" },
  { key: "cardiovascular", label: "Cardiovascular" },
  { key: "respiratory", label: "Respiratory" },
  { key: "gi", label: "Gastrointestinal" },
  { key: "gu", label: "Genitourinary" },
  { key: "skin", label: "Skin / wound" },
  { key: "psychosocial", label: "Psychosocial" },
  { key: "safety", label: "Safety / fall risk" },
];
type Findings = Record<string, string>;
const EMPTY_FINDINGS: Findings = Object.fromEntries(FINDING_SECTIONS.map((s) => [s.key, ""]));

interface ChartData {
  patient: { id: string; uhid: string; fullName: string; sex: string; ageYears: number | null };
  notes: { id: string; type: string; status: string; content: { assessment?: string; [k: string]: unknown }; author: { user: { displayName: string } }; createdAt: string }[];
  medicationOrders: { id: string; drugName: string; dose: string; route: string; status: string }[];
}
interface Assessment { id: string; status: string; version: number; findings: Findings; createdAt: string; completedAt: string | null; signedAt: string | null }
interface FlowsheetEntry { type: string; timestamp: string; summary: string; refId: string }
interface TaskRow { id: string; title: string; status: string; priority: string; dueAt: string | null }
interface CarePlanRow { id: string; problem: string; goal: string; status: string; interventions: { id: string; description: string; responsibleRole: string; status: string; taskId: string | null }[] }

const VITAL_FIELDS = ["hr", "sbp", "dbp", "rr", "spo2", "tempC"] as const;

export function NursingWorkspace({ patientId }: { patientId: string }) {
  const searchParams = useSearchParams();
  const encounterId = searchParams.get("encounterId");
  const push = useToastStore((s) => s.push);

  const [chart, setChart] = useState<ChartData | null>(null);
  const [current, setCurrent] = useState<Assessment | null>(null);
  const [history, setHistory] = useState<Assessment[]>([]);
  const [flowsheet, setFlowsheet] = useState<FlowsheetEntry[] | null>(null);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [carePlans, setCarePlans] = useState<CarePlanRow[]>([]);

  const [findings, setFindings] = useState<Findings>(EMPTY_FINDINGS);
  const [amendReason, setAmendReason] = useState("");
  const [amending, setAmending] = useState(false);
  const [vitalForm, setVitalForm] = useState<Record<string, string>>({});
  const [ioForm, setIoForm] = useState({ ioType: "INPUT" as "INPUT" | "OUTPUT", category: "ORAL", quantityMl: "", notes: "" });
  const [handoffOpen, setHandoffOpen] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/hospital/patients/${patientId}/chart`).then((r) => r.json()).then(setChart);
    fetch(`/api/hospital/patients/${patientId}/care-plans`).then((r) => r.json()).then((d) => setCarePlans(d.carePlans ?? []));
    if (encounterId) {
      fetch(`/api/hospital/encounters/${encounterId}/nursing-assessment`).then((r) => r.json()).then((d) => { setCurrent(d.current); setHistory(d.history ?? []); });
      fetch(`/api/hospital/encounters/${encounterId}/flowsheet`).then((r) => r.json()).then((d) => setFlowsheet(d.entries ?? []));
      fetch(`/api/hospital/tasks?encounterId=${encounterId}`).then((r) => r.json()).then((d) => setTasks(d.tasks ?? []));
    }
  }, [patientId, encounterId]);
  useEffect(load, [load]);

  async function createAssessment() {
    if (!encounterId) return;
    const res = await fetch(`/api/hospital/encounters/${encounterId}/nursing-assessment`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ findings }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push("Assessment drafted.", "emerald"); setFindings(EMPTY_FINDINGS); load();
  }

  async function transitionAssessment(action: "complete" | "sign") {
    if (!encounterId || !current) return;
    const res = await fetch(`/api/hospital/encounters/${encounterId}/nursing-assessment`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assessmentId: current.id, action }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push(action === "complete" ? "Assessment completed." : "Assessment signed.", "emerald"); load();
  }

  async function amendAssessment() {
    if (!encounterId || !current || !amendReason.trim()) { push("Amendment reason is required.", "amber"); return; }
    const res = await fetch(`/api/hospital/encounters/${encounterId}/nursing-assessment`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assessmentId: current.id, action: "amend", findings, amendmentReason: amendReason.trim() }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push("Assessment amended.", "emerald"); setAmending(false); setAmendReason(""); setFindings(EMPTY_FINDINGS); load();
  }

  async function submitVitals() {
    if (!encounterId) return;
    const payload: Record<string, number> = {};
    for (const key of VITAL_FIELDS) if (vitalForm[key]?.trim()) payload[key] = Number(vitalForm[key]);
    if (Object.keys(payload).length === 0) { push("Enter at least one vital reading.", "amber"); return; }
    const res = await fetch(`/api/hospital/encounters/${encounterId}/vitals`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    const data = await res.json();
    push(data.abnormal?.length ? `Vitals recorded — ${data.abnormal.length} out of range.` : "Vitals recorded.", data.abnormal?.length ? "amber" : "emerald");
    setVitalForm({}); load();
  }

  async function submitIo() {
    if (!encounterId || !ioForm.quantityMl.trim()) { push("Quantity is required.", "amber"); return; }
    const res = await fetch(`/api/hospital/encounters/${encounterId}/io`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ioType: ioForm.ioType, category: ioForm.category, quantityMl: Number(ioForm.quantityMl), notes: ioForm.notes || undefined }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push("Intake/output recorded.", "emerald"); setIoForm({ ioType: "INPUT", category: "ORAL", quantityMl: "", notes: "" }); load();
  }

  async function completeTask(taskId: string) {
    const res = await fetch(`/api/hospital/tasks/${taskId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "COMPLETED" }) });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push("Task completed.", "emerald"); load();
  }

  async function completeIntervention(carePlanId: string, interventionId: string) {
    const res = await fetch(`/api/hospital/care-plans/${carePlanId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "completeIntervention", interventionId }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push("Intervention completed.", "emerald"); load();
  }

  if (!chart) return <div className="mx-auto max-w-4xl animate-pulse"><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;

  if (!encounterId) {
    return (
      <div className="mx-auto max-w-4xl">
        <ToastViewport />
        <h1 className="text-[20px] font-semibold tracking-tight">{chart.patient.fullName}</h1>
        <StatusPill label="Open this patient from an active encounter to use the nursing workspace" tone="amber" className="mt-3 rounded-md" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <ToastViewport />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">{chart.patient.fullName}</h1>
          <p className="mt-1 text-[12.5px] text-text-secondary">{chart.patient.uhid} · {chart.patient.ageYears}{chart.patient.sex[0]?.toUpperCase()}</p>
        </div>
        <button onClick={() => setHandoffOpen((v) => !v)} className="flex items-center gap-1.5 rounded-md border border-hairline-strong px-3 py-1.5 text-[12px] font-medium hover:border-cyan/40 hover:text-cyan">
          <Send size={12} /> Handoff
        </button>
      </div>

      {handoffOpen && <Card className="rounded-[20px]"><HandoffComposer patientId={patientId} encounterId={encounterId} type="NURSE" onCreated={() => setHandoffOpen(false)} onCancel={() => setHandoffOpen(false)} /></Card>}

      <Card className="rounded-[20px]">
        <div className="flex items-center gap-2"><Inbox size={14} className="text-cyan" /><CardLabel>Handoffs for this patient</CardLabel></div>
        <div className="mt-2.5"><HandoffInbox patientId={patientId} /></div>
      </Card>

      <Card className="rounded-[20px]">
        <div className="flex items-center gap-2"><ClipboardList size={14} className="text-cyan" /><CardLabel>Nursing assessment</CardLabel></div>
        {current ? (
          <div className="mt-2.5">
            <div className="flex items-center gap-2">
              <StatusPill label={current.status} tone={current.status === "SIGNED" ? "emerald" : current.status === "COMPLETED" ? "cyan" : "amber"} className="rounded-md" />
              <span className="text-[11px] text-text-tertiary">v{current.version} · {new Date(current.createdAt).toLocaleString()}</span>
            </div>
            <div className="mt-2 space-y-1 text-[12px]">
              {FINDING_SECTIONS.filter((s) => current.findings?.[s.key]).map((s) => (
                <p key={s.key}><span className="font-medium">{s.label}:</span> {current.findings[s.key]}</p>
              ))}
            </div>
            <div className="mt-2.5 flex gap-1.5">
              {current.status === "DRAFT" && <button onClick={() => transitionAssessment("complete")} className="rounded-md bg-cyan px-3 py-1 text-[11px] font-medium text-ink hover:brightness-110">Mark complete</button>}
              {current.status === "COMPLETED" && <button onClick={() => transitionAssessment("sign")} className="rounded-md bg-emerald px-3 py-1 text-[11px] font-medium text-white hover:brightness-110">Sign</button>}
              {current.status === "SIGNED" && !amending && <button onClick={() => setAmending(true)} className="rounded-md border border-hairline-strong px-3 py-1 text-[11px] hover:border-cyan/40">Amend</button>}
            </div>
            {amending && (
              <div className="mt-2.5 space-y-1.5 rounded-md bg-black/[0.02] p-2.5">
                {FINDING_SECTIONS.map((s) => (
                  <input key={s.key} value={findings[s.key]} onChange={(e) => setFindings((f) => ({ ...f, [s.key]: e.target.value }))} placeholder={s.label} className="w-full rounded-md border border-hairline bg-white px-2 py-1 text-[11.5px] outline-none" />
                ))}
                <input value={amendReason} onChange={(e) => setAmendReason(e.target.value)} placeholder="Reason for amendment (required)" className="w-full rounded-md border border-hairline bg-white px-2 py-1 text-[11.5px] outline-none" />
                <div className="flex gap-1.5">
                  <button onClick={amendAssessment} className="rounded-md bg-cyan px-3 py-1 text-[11px] font-medium text-ink hover:brightness-110">Save amendment</button>
                  <button onClick={() => { setAmending(false); setAmendReason(""); }} className="rounded-md border border-hairline-strong px-3 py-1 text-[11px]">Cancel</button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="mt-2.5 space-y-1.5">
            {FINDING_SECTIONS.map((s) => (
              <input key={s.key} value={findings[s.key]} onChange={(e) => setFindings((f) => ({ ...f, [s.key]: e.target.value }))} placeholder={s.label} className="w-full rounded-md border border-hairline bg-white px-2 py-1 text-[11.5px] outline-none" />
            ))}
            <button onClick={createAssessment} className="rounded-md bg-cyan px-3 py-1 text-[11px] font-medium text-ink hover:brightness-110">Start assessment</button>
          </div>
        )}
        {history.length > 0 && (
          <details className="mt-2.5">
            <summary className="cursor-pointer text-[11px] text-text-tertiary">Version history ({history.length})</summary>
            <div className="mt-1.5 space-y-1 text-[11px] text-text-tertiary">
              {history.map((h) => <p key={h.id}>v{h.version} · {h.status} · {new Date(h.createdAt).toLocaleString()}</p>)}
            </div>
          </details>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card className="rounded-[20px]">
          <div className="flex items-center gap-2"><Activity size={14} className="text-cyan" /><CardLabel>Record vitals</CardLabel></div>
          <div className="mt-2.5 grid grid-cols-3 gap-1.5">
            {VITAL_FIELDS.map((key) => (
              <input key={key} value={vitalForm[key] ?? ""} onChange={(e) => setVitalForm((f) => ({ ...f, [key]: e.target.value }))} type="number" placeholder={key.toUpperCase()} className="rounded-md border border-hairline bg-white px-2 py-1 text-[11px] outline-none" />
            ))}
          </div>
          <button onClick={submitVitals} className="mt-2 rounded-md bg-cyan px-3 py-1 text-[11px] font-medium text-ink hover:brightness-110">Save vitals</button>
        </Card>

        <Card className="rounded-[20px]">
          <div className="flex items-center gap-2"><Droplet size={14} className="text-cyan" /><CardLabel>Record intake/output</CardLabel></div>
          <div className="mt-2.5 flex gap-1.5">
            <select value={ioForm.ioType} onChange={(e) => setIoForm((f) => ({ ...f, ioType: e.target.value as "INPUT" | "OUTPUT" }))} className="rounded-md border border-hairline bg-white px-2 py-1 text-[11px] outline-none">
              <option value="INPUT">Input</option>
              <option value="OUTPUT">Output</option>
            </select>
            <input value={ioForm.category} onChange={(e) => setIoForm((f) => ({ ...f, category: e.target.value }))} placeholder="Category" className="flex-1 rounded-md border border-hairline bg-white px-2 py-1 text-[11px] outline-none" />
            <input value={ioForm.quantityMl} onChange={(e) => setIoForm((f) => ({ ...f, quantityMl: e.target.value }))} type="number" placeholder="mL" className="w-20 rounded-md border border-hairline bg-white px-2 py-1 text-[11px] outline-none" />
          </div>
          <button onClick={submitIo} className="mt-2 rounded-md bg-cyan px-3 py-1 text-[11px] font-medium text-ink hover:brightness-110">Save I/O</button>
        </Card>
      </div>

      <Card className="rounded-[20px]">
        <div className="flex items-center gap-2"><History size={14} className="text-cyan" /><CardLabel>Flowsheet</CardLabel></div>
        <div className="mt-2.5 space-y-1.5">
          {flowsheet === null && <p className="text-[12px] text-text-tertiary">Loading...</p>}
          {flowsheet?.map((e) => (
            <div key={`${e.type}-${e.refId}`} className="flex gap-3 text-[11.5px]">
              <span className="w-32 shrink-0 text-[10.5px] text-text-tertiary">{new Date(e.timestamp).toLocaleString()}</span>
              <span><span className="font-medium">{e.type.replace(/_/g, " ")}:</span> {e.summary}</span>
            </div>
          ))}
          {flowsheet?.length === 0 && <p className="text-[12px] text-text-tertiary">No entries yet.</p>}
        </div>
      </Card>

      <Card className="rounded-[20px]">
        <div className="flex items-center gap-2"><ListChecks size={14} className="text-cyan" /><CardLabel>Tasks</CardLabel></div>
        <div className="mt-2.5 space-y-1.5">
          {tasks.map((t) => (
            <div key={t.id} className="flex items-center justify-between rounded-md border border-hairline px-3 py-1.5 text-[12px]">
              <span>{t.title} <span className="text-text-tertiary">· {t.priority}{t.dueAt ? ` · due ${new Date(t.dueAt).toLocaleString()}` : ""}</span></span>
              {t.status !== "COMPLETED" && t.status !== "CANCELLED" ? (
                <button onClick={() => completeTask(t.id)} className="rounded-md bg-emerald px-2 py-0.5 text-[10.5px] font-medium text-white hover:brightness-110">Complete</button>
              ) : (
                <StatusPill label={t.status} tone="neutral" className="rounded-md" />
              )}
            </div>
          ))}
          {tasks.length === 0 && <p className="text-[12px] text-text-tertiary">No tasks for this encounter.</p>}
        </div>
      </Card>

      <Card className="rounded-[20px]">
        <div className="flex items-center gap-2"><HeartPulse size={14} className="text-cyan" /><CardLabel>Care plan interventions</CardLabel></div>
        <div className="mt-2.5 space-y-2">
          {carePlans.map((cp) => (
            <div key={cp.id} className="rounded-md border border-hairline p-2.5">
              <p className="text-[12px] font-medium">{cp.problem} <StatusPill label={cp.status} tone={cp.status === "ACTIVE" ? "cyan" : "neutral"} className="ml-1.5 rounded-md" /></p>
              <div className="mt-1 space-y-1">
                {cp.interventions.map((i) => (
                  <div key={i.id} className="flex items-center justify-between text-[11.5px]">
                    <span>{i.description} <span className="text-text-tertiary">({i.responsibleRole})</span></span>
                    {i.status !== "COMPLETED" && i.status !== "CANCELLED" ? (
                      <button onClick={() => completeIntervention(cp.id, i.id)} className="rounded-md border border-hairline-strong px-2 py-0.5 text-[10px] hover:border-emerald/40">Complete</button>
                    ) : (
                      <span className="text-text-tertiary">{i.status}</span>
                    )}
                  </div>
                ))}
                {cp.interventions.length === 0 && <p className="text-[11px] text-text-tertiary">No interventions.</p>}
              </div>
            </div>
          ))}
          {carePlans.length === 0 && <p className="text-[12px] text-text-tertiary">No care plans yet.</p>}
        </div>
      </Card>

      <Card className="rounded-[20px]">
        <div className="flex items-center gap-2"><Pill size={14} className="text-cyan" /><CardLabel>Medications (MAR — administer from My Shift)</CardLabel></div>
        <div className="mt-2.5 space-y-1.5">
          {chart.medicationOrders.map((m) => (
            <div key={m.id} className="flex items-center justify-between text-[11.5px]">
              <span>{m.drugName} {m.dose} · {m.route}</span>
              <StatusPill label={m.status.replace("_", " ")} tone={m.status === "ACTIVE" ? "emerald" : "neutral"} className="rounded-md" />
            </div>
          ))}
          {chart.medicationOrders.length === 0 && <p className="text-[11.5px] text-text-tertiary">No medication orders.</p>}
        </div>
      </Card>

      <Card className="rounded-[20px]">
        <div className="flex items-center gap-2"><FileText size={14} className="text-cyan" /><CardLabel>Notes</CardLabel></div>
        <div className="mt-2.5 space-y-2">
          {chart.notes.map((n) => (
            <div key={n.id} className="rounded-md bg-black/[0.02] p-2 text-[11.5px]">
              <p className="text-text-tertiary">{n.type} · {n.author.user.displayName} · {new Date(n.createdAt).toLocaleString()} · {n.status}</p>
              <p className="mt-1">{n.content.assessment}</p>
            </div>
          ))}
          {chart.notes.length === 0 && <p className="text-[11.5px] text-text-tertiary">No notes yet.</p>}
        </div>
      </Card>
    </div>
  );
}
