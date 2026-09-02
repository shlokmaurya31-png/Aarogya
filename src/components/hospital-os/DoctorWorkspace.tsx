"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Stethoscope, PhoneCall } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";

interface Encounter {
  id: string; type: string; status: string; chiefComplaint: string | null; triageLevel: number | null;
  patient: { id: string; fullName: string; uhid: string; ageYears: number | null; sex: string };
  admission: { bed: { label: string } } | null;
}
interface QueueEntry {
  id: string; queueType: string; status: string; priorityReason: string | null; enteredAt: string;
  patient: { id: string; fullName: string; uhid: string };
  encounter: { id: string } | null;
}

const STATUS_TONE: Record<string, "emerald" | "amber" | "red" | "cyan" | "neutral"> = {
  REGISTERED: "neutral", TRIAGED: "amber", IN_CONSULTATION: "cyan", INVESTIGATING: "amber", ADMITTED: "cyan",
};

export function DoctorWorkspace({ staffId }: { staffId?: string }) {
  const push = useToastStore((s) => s.push);
  const [encounters, setEncounters] = useState<Encounter[] | null>(null);
  const [queue, setQueue] = useState<QueueEntry[]>([]);

  function loadQueue() {
    if (!staffId) return;
    fetch(`/api/hospital/queue?practitionerStaffId=${staffId}`).then((r) => r.json()).then((d) => setQueue(d.entries ?? []));
  }

  useEffect(() => {
    fetch("/api/hospital/encounters").then((r) => r.json()).then((d) => setEncounters(d.encounters ?? []));
    if (staffId) fetch(`/api/hospital/queue?practitionerStaffId=${staffId}`).then((r) => r.json()).then((d) => setQueue(d.entries ?? []));
  }, [staffId]);

  async function callNext(queueType: string) {
    const res = await fetch("/api/hospital/queue/next", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ queueType, practitionerStaffId: staffId }),
    });
    const data = await res.json();
    if (!res.ok) { push(data.error ?? "Failed.", "red"); return; }
    if (!data.entry) { push("Queue is empty.", "cyan"); return; }
    push(`Called ${data.entry.patient?.fullName ?? "next patient"}.`, "emerald");
    loadQueue();
  }

  async function queueAction(id: string, action: string) {
    const res = await fetch(`/api/hospital/queue/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    loadQueue();
  }

  if (!encounters) return <div className="mx-auto max-w-5xl animate-pulse"><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;

  return (
    <div className="mx-auto max-w-5xl">
      <ToastViewport />
      <div className="flex items-center gap-2">
        <Stethoscope size={18} className="text-cyan" />
        <h1 className="text-[20px] font-semibold tracking-tight">My Patients</h1>
      </div>
      <p className="mt-1 text-[13px] text-text-secondary">{encounters.length} active encounters across the facility.</p>

      {staffId && (
        <Card className="mt-4 rounded-[20px]">
          <div className="flex items-center justify-between">
            <p className="text-[13px] font-medium">My queue ({queue?.length ?? 0} waiting)</p>
            <div className="flex gap-1.5">
              <button onClick={() => callNext("OPD_DOCTOR")} className="flex items-center gap-1 rounded-md bg-cyan px-2.5 py-1.5 text-[11.5px] font-medium text-ink hover:brightness-110"><PhoneCall size={11} /> Call next (OPD)</button>
              <button onClick={() => callNext("ED")} className="flex items-center gap-1 rounded-md border border-hairline-strong px-2.5 py-1.5 text-[11.5px] font-medium hover:border-red/40 hover:text-red"><PhoneCall size={11} /> Call next (ED)</button>
            </div>
          </div>
          <div className="mt-2.5 space-y-1.5">
            {queue?.map((q) => (
              <div key={q.id} className="flex items-center justify-between rounded-md border border-hairline px-3 py-1.5 text-[12px]">
                <span>{q.patient.fullName} <span className="text-text-tertiary">· {q.queueType.replace("_", " ")}{q.priorityReason ? ` · ${q.priorityReason}` : ""}</span></span>
                <div className="flex items-center gap-1.5">
                  <StatusPill label={q.status} tone={q.status === "CALLED" ? "amber" : q.status === "IN_SERVICE" ? "cyan" : "neutral"} className="rounded-md" />
                  {q.status !== "IN_SERVICE" && <button onClick={() => queueAction(q.id, "start")} className="rounded-md border border-hairline-strong px-2 py-0.5 text-[10.5px] hover:border-cyan/40">Start</button>}
                  {q.status === "IN_SERVICE" && <button onClick={() => queueAction(q.id, "complete")} className="rounded-md bg-emerald px-2 py-0.5 text-[10.5px] text-white hover:brightness-110">Complete</button>}
                </div>
              </div>
            ))}
            {queue?.length === 0 && <p className="text-[12px] text-text-tertiary">No one waiting in your queue.</p>}
          </div>
        </Card>
      )}

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
