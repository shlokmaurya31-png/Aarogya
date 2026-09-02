"use client";

import { useEffect, useState } from "react";
import { Pill, Activity, Check } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";

interface MedTask { administrationId: string; medicationOrderId: string; patientName: string; bedLabel: string; drug: string; dose: string; route: string; scheduledAt: string }
interface VitalTask { encounterId: string; patientName: string; bedLabel: string; lastRecordedAt: string | null }

export function NurseTasks() {
  const push = useToastStore((s) => s.push);
  const [medTasks, setMedTasks] = useState<MedTask[] | null>(null);
  const [vitalTasks, setVitalTasks] = useState<VitalTask[] | null>(null);

  function load() {
    fetch("/api/hospital/nurse/tasks").then((r) => r.json()).then((d) => {
      setMedTasks(d.medicationTasks ?? []);
      setVitalTasks(d.vitalsTasks ?? []);
    });
  }
  useEffect(load, []);

  async function administer(orderId: string, administrationId: string) {
    const res = await fetch(`/api/hospital/orders/medication/${orderId}/administer`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ administrationId, status: "GIVEN" }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push("Medication administered.", "emerald"); load();
  }

  async function recordVital(encounterId: string) {
    const res = await fetch(`/api/hospital/encounters/${encounterId}/vitals`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hr: 78, sbp: 120, dbp: 80, rr: 16, spo2: 97, tempC: 37.0 }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push("Vitals recorded.", "emerald"); load();
  }

  if (!medTasks || !vitalTasks) return <div className="mx-auto max-w-4xl animate-pulse"><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;

  return (
    <div className="mx-auto max-w-4xl">
      <ToastViewport />
      <h1 className="text-[20px] font-semibold tracking-tight">My Shift</h1>
      <p className="mt-1 text-[13px] text-text-secondary">{medTasks.length} medications due · {vitalTasks.length} vitals due.</p>

      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card className="rounded-[20px]">
          <div className="flex items-center gap-2"><Pill size={14} className="text-cyan" /><CardLabel>Medications due</CardLabel></div>
          <div className="mt-3 space-y-2.5">
            {medTasks.map((t) => (
              <div key={t.administrationId} className="rounded-lg border border-hairline p-3">
                <p className="text-[13px] font-medium">{t.patientName} <span className="font-normal text-text-tertiary">· Bed {t.bedLabel}</span></p>
                <p className="text-[12px] text-text-secondary">{t.drug} {t.dose} · {t.route}</p>
                <button onClick={() => administer(t.medicationOrderId, t.administrationId)} className="mt-2 flex items-center gap-1 rounded-md bg-emerald px-2.5 py-1 text-[11px] font-medium text-white hover:brightness-110">
                  <Check size={11} /> Mark given
                </button>
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
