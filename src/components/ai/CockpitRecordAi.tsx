"use client";

import { useEffect, useState } from "react";
import { ChartAi } from "./ChartAi";

/**
 * Week 4b — the AI Cockpit's record assistant: pick one of your current
 * patients (active encounters at your facility), then a visit brief, a chart
 * question or the handoff, cited from that patient's record only.
 */
export function CockpitRecordAi() {
  const [patients, setPatients] = useState<{ id: string; label: string }[] | null>(null);
  const [selected, setSelected] = useState("");
  useEffect(() => {
    let alive = true;
    fetch("/api/hospital/encounters").then((r) => (r.ok ? r.json() : { encounters: [] })).then((d: { encounters?: { patient: { id: string; fullName: string; uhid: string } }[] }) => {
      if (!alive) return;
      const seen = new Map<string, string>();
      for (const e of d.encounters ?? []) if (!seen.has(e.patient.id)) seen.set(e.patient.id, `${e.patient.fullName} · ${e.patient.uhid}`);
      setPatients([...seen].map(([id, label]) => ({ id, label })));
    }).catch(() => alive && setPatients([]));
    return () => { alive = false; };
  }, []);
  if (!patients?.length) return null;
  return (
    <div className="rounded-3xl border border-hairline bg-card p-5 sm:p-6">
      <label className="text-[12px] font-medium uppercase tracking-wide text-text-tertiary" htmlFor="cockpit-patient">Ask about a patient&apos;s record</label>
      <select id="cockpit-patient" value={selected} onChange={(e) => setSelected(e.target.value)} className="mt-2 w-full rounded-md border border-hairline bg-transparent px-2.5 py-2 text-[13px]">
        <option value="">Choose one of your current patients…</option>
        {patients.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
      {selected && <div className="mt-3"><ChartAi patientId={selected} title="Record assistant (cited, advisory)" /></div>}
    </div>
  );
}
