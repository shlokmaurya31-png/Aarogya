"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Stethoscope } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";

interface Encounter {
  id: string; type: string; status: string; chiefComplaint: string | null; triageLevel: number | null;
  patient: { id: string; fullName: string; uhid: string; ageYears: number | null; sex: string };
  admission: { bed: { label: string } } | null;
}

const STATUS_TONE: Record<string, "emerald" | "amber" | "red" | "cyan" | "neutral"> = {
  REGISTERED: "neutral", TRIAGED: "amber", IN_CONSULTATION: "cyan", INVESTIGATING: "amber", ADMITTED: "cyan",
};

export function DoctorWorkspace() {
  const [encounters, setEncounters] = useState<Encounter[] | null>(null);

  useEffect(() => {
    fetch("/api/hospital/encounters").then((r) => r.json()).then((d) => setEncounters(d.encounters ?? []));
  }, []);

  if (!encounters) return <div className="mx-auto max-w-5xl animate-pulse"><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex items-center gap-2">
        <Stethoscope size={18} className="text-cyan" />
        <h1 className="text-[20px] font-semibold tracking-tight">My Patients</h1>
      </div>
      <p className="mt-1 text-[13px] text-text-secondary">{encounters.length} active encounters across the facility.</p>

      <div className="mt-5 space-y-2.5">
        {encounters.map((e) => (
          <Link key={e.id} href={`/hospital-os/doctor/patients/${e.patient.id}?encounterId=${e.id}`}>
            <Card className="flex items-center justify-between rounded-lg transition hover:border-cyan/30">
              <div>
                <p className="text-[13.5px] font-medium">{e.patient.fullName} <span className="font-normal text-text-tertiary">· {e.patient.ageYears}{e.patient.sex[0]?.toUpperCase()}</span></p>
                <p className="text-[11.5px] text-text-tertiary">{e.patient.uhid} · {e.chiefComplaint ?? "—"}{e.admission ? ` · Bed ${e.admission.bed.label}` : ""}</p>
              </div>
              <div className="flex items-center gap-1.5">
                <StatusPill label={e.type} tone="neutral" className="rounded-md" />
                <StatusPill label={e.status.replaceAll("_", " ")} tone={STATUS_TONE[e.status] ?? "neutral"} className="rounded-md" />
              </div>
            </Card>
          </Link>
        ))}
        {encounters.length === 0 && <p className="text-[13px] text-text-tertiary">No active encounters.</p>}
      </div>
    </div>
  );
}
