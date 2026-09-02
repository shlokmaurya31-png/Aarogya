"use client";

import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";

interface Admission {
  id: string; reason: string; admittedAt: string;
  encounter: { patient: { fullName: string; uhid: string } };
  bed: { label: string; ward: { name: string } };
}
interface Encounter { id: string; chiefComplaint: string | null; type: string; status: string; patient: { fullName: string; uhid: string } }
interface Bed { id: string; label: string; status: string; wardName: string }

export function AdmissionsWorklist() {
  const push = useToastStore((s) => s.push);
  const [admissions, setAdmissions] = useState<Admission[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [encounters, setEncounters] = useState<Encounter[]>([]);
  const [beds, setBeds] = useState<Bed[]>([]);
  const [encounterId, setEncounterId] = useState("");
  const [bedId, setBedId] = useState("");
  const [reason, setReason] = useState("");

  function load() {
    fetch("/api/hospital/admissions").then((r) => r.json()).then((d) => setAdmissions(d.admissions ?? []));
  }
  useEffect(load, []);

  useEffect(() => {
    if (!showForm) return;
    fetch("/api/hospital/encounters").then((r) => r.json()).then((d) => setEncounters((d.encounters ?? []).filter((e: { admission: unknown }) => !e.admission)));
    fetch("/api/hospital/beds").then((r) => r.json()).then((d) => setBeds((d.beds ?? []).filter((b: Bed) => b.status === "AVAILABLE")));
  }, [showForm]);

  async function submitAdmission() {
    if (!encounterId || !bedId || !reason.trim()) return;
    const res = await fetch("/api/hospital/admissions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ encounterId, bedId, reason }),
    });
    const data = await res.json();
    if (!res.ok) { push(data.error ?? "Admission failed.", "red"); return; }
    push("Patient admitted.", "emerald");
    setShowForm(false); setEncounterId(""); setBedId(""); setReason("");
    load();
  }

  return (
    <div className="mx-auto max-w-5xl">
      <ToastViewport />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">Admissions</h1>
          <p className="mt-1 text-[13px] text-text-secondary">{admissions?.length ?? 0} currently admitted.</p>
        </div>
        <button onClick={() => setShowForm((v) => !v)} className="flex items-center gap-1.5 rounded-md bg-cyan px-3.5 py-2 text-[12.5px] font-medium text-ink hover:brightness-110">
          <Plus size={13} /> New admission
        </button>
      </div>

      {showForm && (
        <Card className="mt-4 rounded-[20px]">
          <CardLabel>New admission</CardLabel>
          <div className="mt-3 space-y-3">
            <div>
              <label className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">Encounter (unadmitted)</label>
              <select value={encounterId} onChange={(e) => setEncounterId(e.target.value)} className="mt-1.5 w-full rounded-md border border-hairline bg-black/[0.02] px-3 py-2 text-[13px] outline-none focus:border-cyan/40">
                <option value="">Select...</option>
                {encounters.map((e) => <option key={e.id} value={e.id}>{e.patient.fullName} ({e.patient.uhid}) — {e.chiefComplaint} [{e.type}/{e.status}]</option>)}
              </select>
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">Available bed</label>
              <select value={bedId} onChange={(e) => setBedId(e.target.value)} className="mt-1.5 w-full rounded-md border border-hairline bg-black/[0.02] px-3 py-2 text-[13px] outline-none focus:border-cyan/40">
                <option value="">Select...</option>
                {beds.map((b) => <option key={b.id} value={b.id}>{b.label} — {b.wardName}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">Reason for admission</label>
              <input value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1.5 w-full rounded-md border border-hairline bg-black/[0.02] px-3 py-2 text-[13px] outline-none focus:border-cyan/40" />
            </div>
            <button onClick={submitAdmission} className="rounded-md bg-emerald px-4 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110">Admit patient</button>
          </div>
        </Card>
      )}

      <div className="mt-5 space-y-2.5">
        {admissions?.map((a) => (
          <Card key={a.id} className="flex items-center justify-between rounded-lg">
            <div>
              <p className="text-[13.5px] font-medium">{a.encounter.patient.fullName}</p>
              <p className="text-[11.5px] text-text-tertiary">{a.encounter.patient.uhid} · {a.reason}</p>
            </div>
            <StatusPill label={`${a.bed.label} · ${a.bed.ward.name}`} tone="cyan" className="rounded-md" />
          </Card>
        ))}
        {admissions?.length === 0 && <p className="text-[13px] text-text-tertiary">No active admissions.</p>}
      </div>
    </div>
  );
}
