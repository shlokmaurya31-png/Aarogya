"use client";

import { useEffect, useState, useCallback } from "react";
import { CheckCircle2 } from "lucide-react";
import { useToastStore } from "@/store/useToastStore";

interface Handoff {
  id: string;
  type: "DOCTOR" | "NURSE";
  urgency: "ROUTINE" | "URGENT" | "EMERGENCY";
  summary: string;
  activeProblems: string | null;
  pendingInvestigations: string | null;
  pendingMedications: string | null;
  pendingTasks: string | null;
  safetyConcerns: string | null;
  escalationRequired: boolean;
  status: "PENDING" | "ACKNOWLEDGED";
  createdAt: string;
  patient: { name: string } | null;
  fromStaff: { user: { name: string } } | null;
}

const URGENCY_COLOR: Record<string, string> = { ROUTINE: "text-text-tertiary", URGENT: "text-amber", EMERGENCY: "text-red" };

/**
 * Handoff inbox + acknowledge (brief §15) — the backend GET/PATCH
 * (list-by-toStaffId, acknowledge) already existed with no consuming UI
 * anywhere in the app; this is that UI.
 */
export function HandoffInbox({ toStaffId, patientId, showPatientName = false }: { toStaffId?: string; patientId?: string; showPatientName?: boolean }) {
  const push = useToastStore((s) => s.push);
  const [handoffs, setHandoffs] = useState<Handoff[] | null>(null);

  const load = useCallback(() => {
    const params = new URLSearchParams({ status: "PENDING" });
    if (toStaffId) params.set("toStaffId", toStaffId);
    if (patientId) params.set("patientId", patientId);
    fetch(`/api/hospital/handoffs?${params.toString()}`).then((r) => r.json()).then((d) => setHandoffs(d.handoffs ?? []));
  }, [toStaffId, patientId]);

  useEffect(load, [load]);

  async function acknowledge(id: string) {
    const res = await fetch(`/api/hospital/handoffs/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push("Handoff acknowledged.", "emerald");
    load();
  }

  if (!handoffs) return <div className="animate-pulse"><div className="h-16 rounded-lg bg-black/[0.04]" /></div>;
  if (handoffs.length === 0) return <p className="text-[12.5px] text-text-tertiary">No pending handoffs.</p>;

  return (
    <div className="space-y-2">
      {handoffs.map((h) => (
        <div key={h.id} className="rounded-lg border border-hairline p-3">
          <div className="flex items-center justify-between">
            <p className="text-[11.5px] font-medium">
              {showPatientName && h.patient ? `${h.patient.name} · ` : ""}
              <span className={URGENCY_COLOR[h.urgency]}>{h.urgency}</span>
              {h.escalationRequired && <span className="ml-1.5 rounded bg-red/10 px-1.5 py-0.5 text-[10px] text-red">Escalation</span>}
            </p>
            <span className="text-[10.5px] text-text-tertiary">{new Date(h.createdAt).toLocaleString()}</span>
          </div>
          <p className="mt-1 text-[12px]">{h.summary}</p>
          {h.fromStaff && <p className="mt-0.5 text-[10.5px] text-text-tertiary">From {h.fromStaff.user.name}</p>}
          {h.activeProblems && <p className="mt-1 text-[11px] text-text-secondary">Problems: {h.activeProblems}</p>}
          {h.pendingTasks && <p className="text-[11px] text-text-secondary">Pending: {h.pendingTasks}</p>}
          {h.safetyConcerns && <p className="text-[11px] text-red">Safety: {h.safetyConcerns}</p>}
          <button onClick={() => acknowledge(h.id)} className="mt-2 flex items-center gap-1 rounded-md bg-emerald px-2.5 py-1 text-[11px] font-medium text-white hover:brightness-110">
            <CheckCircle2 size={11} /> Acknowledge
          </button>
        </div>
      ))}
    </div>
  );
}
