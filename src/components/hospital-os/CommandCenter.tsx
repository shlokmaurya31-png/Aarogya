"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, BedDouble, Activity, TrendingUp, TrendingDown, ShieldAlert } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { cn } from "@/lib/utils";

interface Snapshot {
  today: { admissions: number; admissionsDeltaPct: number; discharges: number; edVisits: number; opdVisits: number };
  beds: { total: number; available: number; occupancyPct: number; byStatus: Record<string, number>; byWard: { wardName: string; wardType: string; occupied: number; total: number }[] };
  patientFlow: Record<string, number>;
  safety: { unacknowledgedCriticalLabs: number; unverifiedCriticalImaging: number; pendingDischarges: number };
  operationalStatus: "green" | "watch" | "critical";
  alerts: { id: string; severity: "info" | "watch" | "critical"; department: string; message: string; ownerRole: string; createdAt: string }[];
}

const STATUS_TONE = { green: "emerald", watch: "amber", critical: "red" } as const;
const ALERT_TONE = { info: "cyan", watch: "amber", critical: "red" } as const;

export function CommandCenter() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/hospital/command-center")
      .then(async (res) => { if (!res.ok) throw new Error((await res.json()).error ?? "Failed to load."); return res.json(); })
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <Card className="mx-auto max-w-lg rounded-[20px] text-center">{error}</Card>;
  if (!data) return <div className="mx-auto max-w-6xl animate-pulse space-y-4"><div className="h-24 rounded-[20px] bg-black/[0.04]" /><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[21px] font-semibold tracking-tight">Hospital Command Center</h1>
          <p className="mt-1 text-[13px] text-text-secondary">Aarogya Medical Centre — live operational status</p>
        </div>
        <StatusPill
          label={data.operationalStatus === "green" ? "All systems normal" : data.operationalStatus === "watch" ? "Watch" : "Critical"}
          tone={STATUS_TONE[data.operationalStatus]}
          className="rounded-md px-3 py-1.5 text-[12px]"
        />
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Admissions today" value={data.today.admissions} deltaPct={data.today.admissionsDeltaPct} />
        <StatTile label="Discharges today" value={data.today.discharges} />
        <StatTile label="ED visits today" value={data.today.edVisits} />
        <StatTile label="OPD visits today" value={data.today.opdVisits} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card className="rounded-[20px]">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2"><ShieldAlert size={15} className="text-cyan" /><CardLabel>Alerts</CardLabel></div>
              <span className="text-[11px] text-text-tertiary">{data.alerts.length} active</span>
            </div>
            <div className="mt-3 space-y-2">
              {data.alerts.length === 0 && <p className="text-[12.5px] text-text-tertiary">No active alerts — the hospital is running within normal parameters.</p>}
              {data.alerts.map((a) => (
                <div key={a.id} className={cn("flex items-start gap-2.5 rounded-lg border px-3 py-2.5", a.severity === "critical" ? "border-red/25 bg-red/[0.04]" : a.severity === "watch" ? "border-amber/25 bg-amber/[0.04]" : "border-hairline")}>
                  <AlertTriangle size={14} className={cn("mt-0.5 shrink-0", a.severity === "critical" ? "text-red" : a.severity === "watch" ? "text-amber" : "text-cyan")} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[12.5px]">{a.message}</p>
                    <div className="mt-1 flex items-center gap-2">
                      <StatusPill label={a.department} tone="neutral" className="rounded-md" />
                      <span className="text-[10.5px] text-text-tertiary">owner: {a.ownerRole.replaceAll("_", " ")}</span>
                    </div>
                  </div>
                  <StatusPill label={a.severity} tone={ALERT_TONE[a.severity]} className="rounded-md shrink-0" />
                </div>
              ))}
            </div>
          </Card>

          <Card className="rounded-[20px]">
            <div className="flex items-center gap-2"><Activity size={15} className="text-cyan" /><CardLabel>Patient flow</CardLabel></div>
            <div className="mt-3 grid grid-cols-5 gap-2 text-center">
              {Object.entries(data.patientFlow).map(([stage, count]) => (
                <div key={stage} className="rounded-lg border border-hairline px-2 py-3">
                  <p className="text-[20px] font-semibold tabular-nums">{count}</p>
                  <p className="mt-1 text-[10px] capitalize text-text-tertiary">{stage.replaceAll("_", " ").toLowerCase()}</p>
                </div>
              ))}
            </div>
          </Card>

          <Card className="rounded-[20px]">
            <CardLabel>Bed occupancy by ward</CardLabel>
            <div className="mt-3 space-y-2.5">
              {data.beds.byWard.map((w) => {
                const pct = w.total ? Math.round((w.occupied / w.total) * 100) : 0;
                return (
                  <div key={w.wardName}>
                    <div className="flex items-center justify-between text-[12px]">
                      <span>{w.wardName}</span>
                      <span className="tabular-nums text-text-tertiary">{w.occupied}/{w.total}</span>
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-black/[0.06]">
                      <div className={cn("h-full rounded-full", pct >= 90 ? "bg-red" : pct >= 70 ? "bg-amber" : "bg-emerald")} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="rounded-[20px]">
            <div className="flex items-center gap-2"><BedDouble size={15} className="text-cyan" /><CardLabel>Beds</CardLabel></div>
            <p className="mt-2 text-[28px] font-semibold tabular-nums">{data.beds.occupancyPct}%</p>
            <p className="text-[11.5px] text-text-tertiary">{data.beds.available} available of {data.beds.total}</p>
            <div className="mt-3 space-y-1.5">
              {Object.entries(data.beds.byStatus).map(([status, count]) => (
                <div key={status} className="flex items-center justify-between text-[11.5px]">
                  <span className="text-text-secondary">{status.replaceAll("_", " ")}</span>
                  <span className="tabular-nums">{count}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card className="rounded-[20px]">
            <CardLabel>Patient safety</CardLabel>
            <div className="mt-2 space-y-2.5">
              <SafetyRow label="Unacknowledged critical labs" value={data.safety.unacknowledgedCriticalLabs} />
              <SafetyRow label="Unverified critical imaging" value={data.safety.unverifiedCriticalImaging} />
              <SafetyRow label="Pending discharges" value={data.safety.pendingDischarges} />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function StatTile({ label, value, deltaPct }: { label: string; value: number; deltaPct?: number }) {
  return (
    <Card className="rounded-lg">
      <CardLabel>{label}</CardLabel>
      <div className="mt-1.5 flex items-baseline gap-2">
        <p className="text-[24px] font-semibold tabular-nums">{value}</p>
        {deltaPct !== undefined && deltaPct !== 0 && (
          <span className={cn("flex items-center gap-0.5 text-[11px]", deltaPct > 0 ? "text-amber" : "text-emerald")}>
            {deltaPct > 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />} {Math.abs(deltaPct)}% vs 7-day avg
          </span>
        )}
      </div>
    </Card>
  );
}

function SafetyRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[12px] text-text-secondary">{label}</span>
      <StatusPill label={String(value)} tone={value > 0 ? "red" : "emerald"} className="rounded-md" />
    </div>
  );
}
