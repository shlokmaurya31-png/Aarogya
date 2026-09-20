"use client";

import { Card, SectionTitle, Empty, Unavailable, usePatientData, formatDate, StatusPill } from "@/components/patient-portal/ui";

interface Med { id: string; drug: string; dose: string; frequency: string; statusLabel: string; isActive: boolean; orderedAt: string; }
interface Rx { id: string; drug: string; dose: string; frequency: string; route: string; durationDays: number | null; statusLabel: string; prescribedBy: string; orderedAt: string; }

export default function MedicationsPage() {
  const meds = usePatientData<{ medications: Med[] }>("/api/patient/medications");
  const rx = usePatientData<{ prescriptions: Rx[] }>("/api/patient/prescriptions");
  return (
    <div className="space-y-5">
      <h1 className="text-[18px] font-semibold">Medicines</h1>
      <Card>
        <SectionTitle>Current medicines</SectionTitle>
        {meds.state.status === "loading" ? <Empty>Loading…</Empty> : meds.state.status === "error" ? <Unavailable label="Medicines" /> : (() => {
          const active = meds.state.data.medications.filter((m) => m.isActive);
          return active.length ? (
            <ul className="space-y-2">{active.map((m) => (
              <li key={m.id} className="flex items-center justify-between text-[13px]">
                <span>{m.drug} <span className="text-text-tertiary">· {m.dose} · {m.frequency}</span></span>
                <StatusPill label={m.statusLabel} tone="good" />
              </li>
            ))}</ul>
          ) : <Empty>No current medicines on record.</Empty>;
        })()}
      </Card>
      <Card>
        <SectionTitle>Prescriptions</SectionTitle>
        {rx.state.status === "loading" ? <Empty>Loading…</Empty> : rx.state.status === "error" ? <Unavailable label="Prescriptions" /> : rx.state.data.prescriptions.length === 0 ? <Empty>No prescriptions on record.</Empty> : (
          <ul className="space-y-3">{rx.state.data.prescriptions.map((p) => (
            <li key={p.id} className="border-b border-hairline pb-3 last:border-0 last:pb-0">
              <div className="flex items-center justify-between">
                <span className="text-[14px] font-medium">{p.drug}</span>
                <StatusPill label={p.statusLabel} />
              </div>
              <div className="text-[12px] text-text-secondary">{p.dose} · {p.frequency} · {p.route}{p.durationDays ? ` · ${p.durationDays} days` : ""}</div>
              <div className="text-[12px] text-text-tertiary">Prescribed by {p.prescribedBy} on {formatDate(p.orderedAt)}</div>
            </li>
          ))}</ul>
        )}
      </Card>
    </div>
  );
}
