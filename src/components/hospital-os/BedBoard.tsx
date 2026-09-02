"use client";

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { cn } from "@/lib/utils";

interface BedRow {
  id: string; label: string; status: string; wardName: string; wardType: string;
  isolationRequired: boolean; currentPatient: { patientId: string; name: string; admissionId: string; reason: string } | null;
}

const STATUS_TONE: Record<string, "emerald" | "amber" | "red" | "cyan" | "neutral"> = {
  AVAILABLE: "emerald", OCCUPIED: "cyan", RESERVED: "amber", CLEANING: "amber",
  BLOCKED: "red", MAINTENANCE: "red", ISOLATION: "red", TRANSFER_PENDING: "amber",
};

export function BedBoard() {
  const push = useToastStore((s) => s.push);
  const [beds, setBeds] = useState<BedRow[] | null>(null);
  const [wardFilter, setWardFilter] = useState("all");

  function load() {
    fetch("/api/hospital/beds").then((r) => r.json()).then((d) => setBeds(d.beds ?? []));
  }
  useEffect(load, []);

  async function completeCleaning(bedId: string) {
    const res = await fetch(`/api/hospital/beds/${bedId}/clean`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) { push(data.error ?? "Failed.", "red"); return; }
    push("Bed marked available.", "emerald");
    load();
  }

  if (!beds) return <div className="mx-auto max-w-6xl animate-pulse"><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;

  const wards = [...new Set(beds.map((b) => b.wardName))];
  const visible = wardFilter === "all" ? beds : beds.filter((b) => b.wardName === wardFilter);

  return (
    <div className="mx-auto max-w-6xl">
      <ToastViewport />
      <h1 className="text-[20px] font-semibold tracking-tight">Bed Board</h1>
      <p className="mt-1 text-[13px] text-text-secondary">{beds.filter((b) => b.status === "AVAILABLE").length} of {beds.length} beds available.</p>

      <div className="mt-4 flex flex-wrap gap-1.5">
        <button onClick={() => setWardFilter("all")} className={cn("rounded-full px-3 py-1 text-[11.5px]", wardFilter === "all" ? "bg-cyan text-ink" : "border border-hairline text-text-secondary")}>All wards</button>
        {wards.map((w) => (
          <button key={w} onClick={() => setWardFilter(w)} className={cn("rounded-full px-3 py-1 text-[11.5px]", wardFilter === w ? "bg-cyan text-ink" : "border border-hairline text-text-secondary")}>{w}</button>
        ))}
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {visible.map((bed) => (
          <Card key={bed.id} className={cn("rounded-lg", bed.status !== "AVAILABLE" && bed.status !== "OCCUPIED" && "border-red/20")}>
            <div className="flex items-center justify-between">
              <p className="text-[13px] font-semibold">{bed.label}</p>
              <StatusPill label={bed.status.replaceAll("_", " ")} tone={STATUS_TONE[bed.status] ?? "neutral"} className="rounded-md" />
            </div>
            <p className="mt-1 text-[11px] text-text-tertiary">{bed.wardName}</p>
            {bed.currentPatient ? (
              <div className="mt-2 rounded-md bg-black/[0.03] p-2 text-[11.5px]">
                <p className="font-medium">{bed.currentPatient.name}</p>
                <p className="text-text-tertiary">{bed.currentPatient.reason}</p>
              </div>
            ) : bed.status === "CLEANING" ? (
              <button onClick={() => completeCleaning(bed.id)} className="mt-2 flex items-center gap-1 rounded-md border border-hairline px-2 py-1 text-[11px] text-text-secondary hover:border-emerald/40 hover:text-emerald">
                <Sparkles size={11} /> Mark cleaned
              </button>
            ) : (
              <p className="mt-2 text-[11px] text-text-tertiary">Unoccupied</p>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
