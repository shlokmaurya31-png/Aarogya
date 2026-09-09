"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { HeartPulse, Wind, ShieldAlert, ChartLine } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { ToastViewport } from "@/components/shared/ToastViewport";

interface BoardBed {
  bedId: string;
  bedLabel: string;
  icuUnit: string;
  status: string;
  ventilatorCapable: boolean;
  negativePressure: boolean;
  patient: { id: string; fullName: string; uhid: string } | null;
  encounterId: string | null;
  attending: string | null;
  latestVital: { hr: number | null; sbp: number | null; dbp: number | null; spo2: number | null; tempC: number | null; recordedAt: string } | null;
  openTasks: number;
}

const BED_TONE: Record<string, "emerald" | "amber" | "red" | "cyan" | "neutral"> = {
  AVAILABLE: "emerald", OCCUPIED: "cyan", RESERVED: "amber", CLEANING: "neutral", BLOCKED: "red", MAINTENANCE: "neutral", ISOLATION: "amber", TRANSFER_PENDING: "amber",
};

export function IcuBoard() {
  const [board, setBoard] = useState<BoardBed[] | null>(null);

  useEffect(() => {
    fetch("/api/hospital/icu/board").then((r) => r.json()).then((d) => setBoard(d.board ?? []));
  }, []);

  if (!board) return <div className="mx-auto max-w-6xl animate-pulse"><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;

  return (
    <div className="mx-auto max-w-6xl">
      <ToastViewport />
      <div className="flex items-center gap-2">
        <HeartPulse size={18} className="text-cyan" />
        <h1 className="text-[20px] font-semibold tracking-tight">ICU Board</h1>
      </div>
      <p className="mt-1 text-[13px] text-text-secondary">{board.filter((b) => b.patient).length} occupied · {board.length} ICU beds.</p>

      {board.length === 0 && (
        <Card className="mt-5 rounded-[20px]"><p className="text-[13px] text-text-tertiary">No ICU-capable beds configured yet. A hospital administrator can mark beds ICU-capable and create ICU units.</p></Card>
      )}

      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {board.map((b) => (
          <Card key={b.bedId} className="rounded-[20px]">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CardLabel>{b.bedLabel}</CardLabel>
                {b.ventilatorCapable && <Wind size={12} className="text-cyan" aria-label="Ventilator-capable" />}
                {b.negativePressure && <ShieldAlert size={12} className="text-amber" aria-label="Negative pressure" />}
              </div>
              <StatusPill label={b.status} tone={BED_TONE[b.status] ?? "neutral"} className="rounded-md" />
            </div>
            <p className="mt-1 text-[11px] text-text-tertiary">{b.icuUnit}</p>

            {b.patient ? (
              <div className="mt-2.5">
                <p className="text-[13px] font-medium">{b.patient.fullName}</p>
                <p className="text-[11px] text-text-tertiary">{b.patient.uhid}{b.attending ? ` · ${b.attending}` : ""}</p>
                {b.latestVital ? (
                  <p className="mt-1.5 text-[11.5px] tabular-nums">
                    HR {b.latestVital.hr ?? "-"} · BP {b.latestVital.sbp ?? "-"}/{b.latestVital.dbp ?? "-"} · SpO2 {b.latestVital.spo2 ?? "-"}% · {b.latestVital.tempC ?? "-"}°C
                  </p>
                ) : (
                  <p className="mt-1.5 text-[11px] text-text-tertiary">No vitals recorded.</p>
                )}
                {b.openTasks > 0 && <p className="mt-1 text-[11px] text-amber">{b.openTasks} open task(s)</p>}
                {b.encounterId && (
                  <Link href={`/hospital-os/icu/${b.encounterId}`} className="mt-2 inline-flex items-center gap-1 rounded-md border border-hairline-strong px-2.5 py-1 text-[11px] hover:border-cyan/40 hover:text-cyan">
                    <ChartLine size={11} /> Open ICU workspace
                  </Link>
                )}
              </div>
            ) : (
              <p className="mt-2.5 text-[12px] text-text-tertiary">Unoccupied</p>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
