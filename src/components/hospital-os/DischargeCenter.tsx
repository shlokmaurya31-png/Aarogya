"use client";

import { useEffect, useState } from "react";
import { Check, DoorOpen } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";

interface Admission {
  id: string; reason: string;
  encounter: { patient: { fullName: string; uhid: string } };
  bed: { label: string };
  discharge: { id: string; clinicallyReady: boolean; documentationReady: boolean; billingReady: boolean; insuranceReady: boolean; pharmacyReady: boolean; transportReady: boolean; dischargedAt: string | null } | null;
}

const FLAGS = [
  { key: "clinicallyReady", label: "Clinically ready" },
  { key: "documentationReady", label: "Documentation" },
  { key: "billingReady", label: "Billing" },
  { key: "insuranceReady", label: "Insurance" },
  { key: "pharmacyReady", label: "Pharmacy" },
  { key: "transportReady", label: "Transport" },
] as const;

export function DischargeCenter() {
  const push = useToastStore((s) => s.push);
  const [admissions, setAdmissions] = useState<Admission[] | null>(null);

  function load() {
    fetch("/api/hospital/admissions").then((r) => r.json()).then((d) => setAdmissions(d.admissions ?? []));
  }
  useEffect(load, []);

  async function initiate(admissionId: string) {
    const res = await fetch(`/api/hospital/admissions/${admissionId}/discharge`, { method: "POST" });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push("Discharge initiated.", "cyan");
    load();
  }

  async function toggleFlag(admissionId: string, key: string, value: boolean) {
    const res = await fetch(`/api/hospital/admissions/${admissionId}/discharge`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [key]: value }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    load();
  }

  async function finalize(admissionId: string) {
    const res = await fetch(`/api/hospital/admissions/${admissionId}/discharge/finalize`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dischargeSummary: { note: "Discharged via Discharge Command Center." } }),
    });
    const data = await res.json();
    if (!res.ok) { push(data.error ?? "Not ready to discharge.", "red"); return; }
    push("Patient discharged — bed released for cleaning.", "emerald");
    load();
  }

  if (!admissions) return <div className="mx-auto max-w-5xl animate-pulse"><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;

  return (
    <div className="mx-auto max-w-5xl">
      <ToastViewport />
      <h1 className="text-[20px] font-semibold tracking-tight">Discharge Command Center</h1>
      <p className="mt-1 text-[13px] text-text-secondary">Shows exactly why each patient hasn&apos;t left — this is what improves bed turnover.</p>

      <div className="mt-5 space-y-3">
        {admissions.map((a) => (
          <Card key={a.id} className="rounded-[20px]">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[14px] font-medium">{a.encounter.patient.fullName}</p>
                <p className="text-[11.5px] text-text-tertiary">{a.encounter.patient.uhid} · Bed {a.bed.label} · {a.reason}</p>
              </div>
              {!a.discharge ? (
                <button onClick={() => initiate(a.id)} className="flex items-center gap-1.5 rounded-md border border-hairline-strong px-3.5 py-2 text-[12px] font-medium hover:border-cyan/40 hover:text-cyan">
                  <DoorOpen size={13} /> Initiate discharge
                </button>
              ) : a.discharge.dischargedAt ? (
                <StatusPill label="Discharged" tone="emerald" className="rounded-md" />
              ) : (
                <button
                  onClick={() => finalize(a.id)}
                  className="flex items-center gap-1.5 rounded-md bg-emerald px-3.5 py-2 text-[12px] font-medium text-white hover:brightness-110"
                >
                  <Check size={13} /> Finalize discharge
                </button>
              )}
            </div>

            {a.discharge && !a.discharge.dischargedAt && (
              <div className="mt-3 flex flex-wrap gap-2 border-t border-hairline pt-3">
                {FLAGS.map((f) => {
                  const value = a.discharge![f.key];
                  return (
                    <label key={f.key} className="flex cursor-pointer items-center gap-1.5 rounded-full border border-hairline px-3 py-1 text-[11.5px]">
                      <input type="checkbox" checked={value} onChange={(e) => toggleFlag(a.id, f.key, e.target.checked)} />
                      {f.label}
                    </label>
                  );
                })}
              </div>
            )}
          </Card>
        ))}
        {admissions.length === 0 && <p className="text-[13px] text-text-tertiary">No active admissions.</p>}
      </div>
    </div>
  );
}
