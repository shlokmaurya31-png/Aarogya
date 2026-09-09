"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Scissors, ChartLine } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { ToastViewport } from "@/components/shared/ToastViewport";

interface BoardEntry {
  scheduleId: string; surgeryId: string; ot: string; startAt: string; endAt: string;
  procedureName: string; status: string; laterality: string | null; urgency: string;
  patient: { id: string; fullName: string; uhid: string };
  checklistProgress: string; recoveryStatus: string | null;
}

const STATUS_TONE: Record<string, "emerald" | "amber" | "red" | "cyan" | "neutral"> = {
  SCHEDULED: "cyan", IN_PROGRESS: "amber", COMPLETED: "emerald", CANCELLED: "red",
};

export function OtBoard() {
  const [board, setBoard] = useState<BoardEntry[] | null>(null);

  useEffect(() => {
    fetch("/api/hospital/ot/board").then((r) => r.json()).then((d) => setBoard(d.board ?? []));
  }, []);

  if (!board) return <div className="mx-auto max-w-6xl animate-pulse"><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;

  return (
    <div className="mx-auto max-w-6xl">
      <ToastViewport />
      <div className="flex items-center gap-2">
        <Scissors size={18} className="text-cyan" />
        <h1 className="text-[20px] font-semibold tracking-tight">Operating Theatre Board</h1>
      </div>
      <p className="mt-1 text-[13px] text-text-secondary">{board.length} scheduled procedure(s).</p>

      {board.length === 0 && (
        <Card className="mt-5 rounded-[20px]"><p className="text-[13px] text-text-tertiary">No scheduled surgeries. Create a surgery request from a patient encounter, then review, approve, and schedule it.</p></Card>
      )}

      <div className="mt-5 space-y-2.5">
        {board.map((b) => (
          <Card key={b.scheduleId} className="rounded-[20px]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-[13.5px] font-medium">{b.procedureName}{b.laterality && b.laterality !== "NA" ? ` · ${b.laterality}` : ""}</p>
                <p className="text-[11.5px] text-text-tertiary">{b.patient.fullName} · {b.patient.uhid} · {b.ot}</p>
                <p className="mt-0.5 text-[11px] text-text-tertiary">{new Date(b.startAt).toLocaleString()} → {new Date(b.endAt).toLocaleTimeString()}</p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {b.urgency !== "ELECTIVE" && <StatusPill label={b.urgency} tone={b.urgency === "EMERGENCY" ? "red" : "amber"} className="rounded-md" />}
                <StatusPill label={b.status.replace("_", " ")} tone={STATUS_TONE[b.status] ?? "neutral"} className="rounded-md" />
                <StatusPill label={`Checklist ${b.checklistProgress}`} tone="neutral" className="rounded-md" />
                {b.recoveryStatus && <StatusPill label={`Recovery: ${b.recoveryStatus}`} tone="cyan" className="rounded-md" />}
                <Link href={`/hospital-os/ot/${b.surgeryId}`} className="flex items-center gap-1 rounded-md border border-hairline-strong px-2.5 py-1 text-[11px] hover:border-cyan/40 hover:text-cyan">
                  <ChartLine size={11} /> Open
                </Link>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
