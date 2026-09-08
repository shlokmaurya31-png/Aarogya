"use client";

import { useState } from "react";
import { Send, X } from "lucide-react";
import { useToastStore } from "@/store/useToastStore";

/**
 * Structured clinical handoff composer (brief §15) — replaces the previous
 * `window.prompt("Handoff summary?")` with real fields for every column
 * the ClinicalHandoff model/API already support (urgency, active problems,
 * pending investigations/medications/tasks, safety concerns, escalation).
 */
export function HandoffComposer({
  patientId,
  encounterId,
  type,
  onCreated,
  onCancel,
}: {
  patientId: string;
  encounterId?: string | null;
  type: "DOCTOR" | "NURSE";
  onCreated: () => void;
  onCancel: () => void;
}) {
  const push = useToastStore((s) => s.push);
  const [urgency, setUrgency] = useState<"ROUTINE" | "URGENT" | "EMERGENCY">("ROUTINE");
  const [summary, setSummary] = useState("");
  const [activeProblems, setActiveProblems] = useState("");
  const [pendingInvestigations, setPendingInvestigations] = useState("");
  const [pendingMedications, setPendingMedications] = useState("");
  const [pendingTasks, setPendingTasks] = useState("");
  const [safetyConcerns, setSafetyConcerns] = useState("");
  const [escalationRequired, setEscalationRequired] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!summary.trim()) { push("Summary is required.", "amber"); return; }
    setSubmitting(true);
    const res = await fetch("/api/hospital/handoffs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        patientId,
        encounterId: encounterId ?? undefined,
        type,
        urgency,
        summary: summary.trim(),
        activeProblems: activeProblems.trim() || undefined,
        pendingInvestigations: pendingInvestigations.trim() || undefined,
        pendingMedications: pendingMedications.trim() || undefined,
        pendingTasks: pendingTasks.trim() || undefined,
        safetyConcerns: safetyConcerns.trim() || undefined,
        escalationRequired,
      }),
    });
    setSubmitting(false);
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push("Handoff created.", "emerald");
    onCreated();
  }

  return (
    <div className="mt-2 space-y-2 rounded-md bg-black/[0.02] p-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">New handoff</p>
        <button onClick={onCancel} className="rounded-md border border-hairline-strong p-1 text-text-tertiary hover:text-ink"><X size={11} /></button>
      </div>
      <textarea
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        placeholder="Summary (required)"
        rows={2}
        className="w-full rounded-md border border-hairline bg-white px-2 py-1.5 text-[12px] outline-none"
      />
      <div className="flex items-center gap-2">
        <label className="text-[11px] text-text-tertiary">Urgency</label>
        <select value={urgency} onChange={(e) => setUrgency(e.target.value as typeof urgency)} className="rounded-md border border-hairline bg-white px-2 py-1 text-[11px] outline-none">
          <option value="ROUTINE">Routine</option>
          <option value="URGENT">Urgent</option>
          <option value="EMERGENCY">Emergency</option>
        </select>
        <label className="flex items-center gap-1.5 text-[11px]">
          <input type="checkbox" checked={escalationRequired} onChange={(e) => setEscalationRequired(e.target.checked)} /> Escalation required
        </label>
      </div>
      <input value={activeProblems} onChange={(e) => setActiveProblems(e.target.value)} placeholder="Active problems" className="w-full rounded-md border border-hairline bg-white px-2 py-1 text-[11.5px] outline-none" />
      <input value={pendingInvestigations} onChange={(e) => setPendingInvestigations(e.target.value)} placeholder="Pending investigations" className="w-full rounded-md border border-hairline bg-white px-2 py-1 text-[11.5px] outline-none" />
      <input value={pendingMedications} onChange={(e) => setPendingMedications(e.target.value)} placeholder="Pending medications" className="w-full rounded-md border border-hairline bg-white px-2 py-1 text-[11.5px] outline-none" />
      <input value={pendingTasks} onChange={(e) => setPendingTasks(e.target.value)} placeholder="Pending tasks" className="w-full rounded-md border border-hairline bg-white px-2 py-1 text-[11.5px] outline-none" />
      <input value={safetyConcerns} onChange={(e) => setSafetyConcerns(e.target.value)} placeholder="Safety concerns" className="w-full rounded-md border border-hairline bg-white px-2 py-1 text-[11.5px] outline-none" />
      <div className="flex gap-1.5">
        <button onClick={submit} disabled={submitting} className="flex items-center gap-1 rounded-md bg-cyan px-2.5 py-1 text-[11px] font-medium text-ink hover:brightness-110 disabled:opacity-40">
          <Send size={11} /> Send handoff
        </button>
        <button onClick={onCancel} className="rounded-md border border-hairline-strong px-2.5 py-1 text-[11px]">Cancel</button>
      </div>
    </div>
  );
}
