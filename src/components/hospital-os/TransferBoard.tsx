"use client";

import { useEffect, useState } from "react";
import { ArrowRightLeft } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";

interface Bed { id: string; label: string; ward: { name: string } }
interface TransferReq {
  id: string; status: string; reason: string; priority: string; createdAt: string;
  patient: { fullName: string; uhid: string };
  admission: { bed: { label: string; ward: { name: string } } };
  reservedBed: Bed | null;
}

const STATUS_TONE: Record<string, "emerald" | "amber" | "red" | "cyan" | "neutral"> = {
  REQUESTED: "neutral", ACCEPTED: "cyan", BED_RESERVED: "amber", PATIENT_IN_TRANSIT: "amber", COMPLETED: "emerald",
};

export function TransferBoard() {
  const push = useToastStore((s) => s.push);
  const [requests, setRequests] = useState<TransferReq[] | null>(null);
  const [eligibleBedsFor, setEligibleBedsFor] = useState<string | null>(null);
  const [eligibleBeds, setEligibleBeds] = useState<Bed[]>([]);

  function load() {
    fetch("/api/hospital/transfer-requests").then((r) => r.json()).then((d) => setRequests(d.requests ?? []));
  }
  useEffect(load, []);

  async function act(id: string, action: string, extra?: Record<string, unknown>) {
    const res = await fetch(`/api/hospital/transfer-requests/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...extra }),
    });
    const data = await res.json();
    if (!res.ok) { push(data.error ?? "Failed.", "red"); return; }
    push(`Transfer ${action === "complete" ? "completed" : action}.`, "emerald");
    setEligibleBedsFor(null);
    load();
  }

  async function openBedPicker(id: string) {
    const res = await fetch(`/api/hospital/transfer-requests/${id}/eligible-beds`);
    const data = await res.json();
    setEligibleBeds(data.beds ?? []);
    setEligibleBedsFor(id);
  }

  if (!requests) return <div className="mx-auto max-w-5xl animate-pulse"><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;

  return (
    <div className="mx-auto max-w-5xl">
      <ToastViewport />
      <div className="flex items-center gap-2">
        <ArrowRightLeft size={18} className="text-cyan" />
        <h1 className="text-[20px] font-semibold tracking-tight">Transfer Board</h1>
      </div>
      <p className="mt-1 text-[13px] text-text-secondary">{requests.length} pending internal transfers.</p>

      <div className="mt-5 space-y-2.5">
        {requests.map((r) => (
          <Card key={r.id} className="rounded-[20px]">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[13.5px] font-medium">{r.patient.fullName} <span className="font-normal text-text-tertiary">· {r.patient.uhid}</span></p>
                <p className="text-[11.5px] text-text-tertiary">From {r.admission.bed.label} ({r.admission.bed.ward.name}) · {r.reason}</p>
              </div>
              <StatusPill label={r.status.replaceAll("_", " ")} tone={STATUS_TONE[r.status] ?? "neutral"} className="rounded-md" />
            </div>

            {eligibleBedsFor === r.id && (
              <div className="mt-3 flex flex-wrap gap-1.5 border-t border-hairline pt-3">
                {eligibleBeds.map((b) => (
                  <button key={b.id} onClick={() => act(r.id, "reserveBed", { bedId: b.id })} className="rounded-md border border-hairline-strong px-2.5 py-1.5 text-[11.5px] hover:border-cyan/40 hover:text-cyan">
                    {b.label} — {b.ward.name}
                  </button>
                ))}
                {eligibleBeds.length === 0 && <p className="text-[12px] text-text-tertiary">No eligible beds available.</p>}
              </div>
            )}

            <div className="mt-3 flex flex-wrap gap-1.5">
              {r.status === "REQUESTED" && <button onClick={() => act(r.id, "accept")} className="rounded-md bg-cyan px-3 py-1.5 text-[11.5px] font-medium text-ink hover:brightness-110">Accept</button>}
              {r.status === "ACCEPTED" && <button onClick={() => openBedPicker(r.id)} className="rounded-md border border-hairline-strong px-3 py-1.5 text-[11.5px] font-medium hover:border-cyan/40 hover:text-cyan">Reserve destination bed</button>}
              {r.status === "BED_RESERVED" && (
                <>
                  <StatusPill label={`Reserved: ${r.reservedBed?.label ?? "?"}`} tone="amber" className="rounded-md" />
                  <button onClick={() => act(r.id, "markInTransit")} className="rounded-md border border-hairline-strong px-3 py-1.5 text-[11.5px] font-medium hover:border-cyan/40 hover:text-cyan">Patient in transit</button>
                  <button onClick={() => act(r.id, "complete")} className="rounded-md bg-emerald px-3 py-1.5 text-[11.5px] font-medium text-white hover:brightness-110">Complete transfer</button>
                </>
              )}
              {r.status === "PATIENT_IN_TRANSIT" && <button onClick={() => act(r.id, "complete")} className="rounded-md bg-emerald px-3 py-1.5 text-[11.5px] font-medium text-white hover:brightness-110">Complete transfer</button>}
              {!["COMPLETED", "CANCELLED", "REJECTED"].includes(r.status) && (
                <button onClick={() => act(r.id, "cancel")} className="rounded-md border border-hairline-strong px-3 py-1.5 text-[11.5px] hover:border-red/40 hover:text-red">Cancel</button>
              )}
            </div>
          </Card>
        ))}
        {requests.length === 0 && <p className="text-[13px] text-text-tertiary">No pending transfers.</p>}
      </div>
    </div>
  );
}
