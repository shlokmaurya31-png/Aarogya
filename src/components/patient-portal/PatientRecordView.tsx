"use client";

import { useEffect, useState } from "react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";

interface PatientMeResponse {
  summary: {
    patient: { uhid: string; fullName: string; sex: string; ageYears: number | null; bloodGroup: string | null };
    activeProblems: { id: string; diagnosis: string; status: string }[];
    activeAllergies: { id: string; substance: string; severity: string }[];
    activeMedications: { id: string; drugName: string; dose: string; frequency: string }[];
    recentEncounters: { id: string; type: string; status: string; chiefComplaint: string | null; registeredAt: string; department: { name: string } | null }[];
  };
  timeline: { id: string; timestamp: string; type: string; summary: string }[];
}

export function PatientRecordView() {
  const [data, setData] = useState<PatientMeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/patient/me")
      .then(async (res) => { if (!res.ok) throw new Error((await res.json()).error ?? "Failed to load."); return res.json(); })
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <Card className="rounded-[20px] text-center">{error}</Card>;
  if (!data) return <div className="animate-pulse space-y-4"><div className="h-24 rounded-[20px] bg-black/[0.04]" /><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;

  const { summary, timeline } = data;

  return (
    <div className="space-y-4">
      <Card className="rounded-[20px]">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[16px] font-semibold">{summary.patient.fullName}</p>
            <p className="text-[12px] text-text-tertiary">{summary.patient.uhid} · {summary.patient.ageYears ?? "—"}{summary.patient.sex[0]?.toUpperCase()} · {summary.patient.bloodGroup ?? "Blood group unknown"}</p>
          </div>
        </div>
        {summary.activeAllergies.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {summary.activeAllergies.map((a) => (
              <span key={a.id} className="rounded-md bg-red/10 px-2 py-1 text-[11px] text-red">Allergy: {a.substance} ({a.severity})</span>
            ))}
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card className="rounded-[20px]">
          <CardLabel>Active problems</CardLabel>
          <div className="mt-2 space-y-1.5">
            {summary.activeProblems.length === 0 && <p className="text-[12px] text-text-tertiary">None on file.</p>}
            {summary.activeProblems.map((p) => <StatusPill key={p.id} label={p.diagnosis} tone="amber" className="mr-1 rounded-md" />)}
          </div>
        </Card>
        <Card className="rounded-[20px]">
          <CardLabel>Current medications</CardLabel>
          <div className="mt-2 space-y-1.5">
            {summary.activeMedications.length === 0 && <p className="text-[12px] text-text-tertiary">None on file.</p>}
            {summary.activeMedications.map((m) => (
              <p key={m.id} className="text-[12.5px]">{m.drugName} {m.dose} · {m.frequency}</p>
            ))}
          </div>
        </Card>
      </div>

      <Card className="rounded-[20px]">
        <CardLabel>Recent encounters</CardLabel>
        <div className="mt-2 space-y-2">
          {summary.recentEncounters.length === 0 && <p className="text-[12px] text-text-tertiary">No visits on file yet.</p>}
          {summary.recentEncounters.map((e) => (
            <div key={e.id} className="flex items-center justify-between rounded-md bg-black/[0.02] px-3 py-2 text-[12.5px]">
              <span>{e.type}{e.department ? ` · ${e.department.name}` : ""} — {e.chiefComplaint ?? "—"}</span>
              <StatusPill label={e.status.replaceAll("_", " ")} tone="neutral" className="rounded-md" />
            </div>
          ))}
        </div>
      </Card>

      <Card className="rounded-[20px]">
        <CardLabel>Timeline</CardLabel>
        <div className="mt-2 space-y-2.5">
          {timeline.slice(0, 20).map((t) => (
            <div key={t.id} className="flex gap-3 text-[12.5px]">
              <span className="w-16 shrink-0 text-[11px] text-text-tertiary">{new Date(t.timestamp).toLocaleDateString()}</span>
              <span><span className="font-medium">{t.type}:</span> {t.summary}</span>
            </div>
          ))}
          {timeline.length === 0 && <p className="text-[12px] text-text-tertiary">No history recorded yet.</p>}
        </div>
      </Card>
    </div>
  );
}
