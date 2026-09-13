"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle, BedDouble, Activity, ShieldAlert, ShieldCheck, ChevronRight,
} from "lucide-react";
import Link from "next/link";
import { Card, CardHeader, CardLabel } from "@/components/ui/Card";
import { StatusPill, Badge } from "@/components/ui/StatusPill";
import { Stat } from "@/components/ui/Stat";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils";

interface Snapshot {
  today: { admissions: number; admissionsDeltaPct: number; discharges: number; edVisits: number; opdVisits: number };
  beds: { total: number; available: number; occupancyPct: number; byStatus: Record<string, number>; byWard: { wardName: string; wardType: string; occupied: number; total: number }[] };
  patientFlow: Record<string, number>;
  safety: { unacknowledgedCriticalLabs: number; unverifiedCriticalImaging: number; pendingDischarges: number };
  access: { appointmentsToday: number; noShowsToday: number; opdWaiting: number; edWaiting: number };
  patientFlowOps: {
    queues: { queueType: string; status: string; count: number }[];
    admissionRequestsPending: number;
    admissionRequestsBedReserved: number;
    transferBacklog: number;
    dischargeReadyNotLeft: number;
  };
  operationalStatus: "green" | "watch" | "critical";
  alerts: { id: string; severity: "info" | "watch" | "critical"; department: string; message: string; ownerRole: string; createdAt: string }[];
}

const OP_STATUS = {
  green: { tone: "success", label: "All systems normal", icon: ShieldCheck },
  watch: { tone: "warning", label: "Watch", icon: ShieldAlert },
  critical: { tone: "critical", label: "Critical", icon: ShieldAlert },
} as const;

const ALERT_TONE = { info: "info", watch: "warning", critical: "critical" } as const;

export function CommandCenter() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/hospital/command-center")
      .then(async (res) => { if (!res.ok) throw new Error((await res.json()).error ?? "Failed to load."); return res.json(); })
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  if (error) {
    return (
      <div className="mx-auto max-w-6xl">
        <Card className="mx-auto max-w-lg">
          <EmptyState
            icon={<AlertTriangle />}
            title="Couldn't load the command center"
            description={error}
          />
        </Card>
      </div>
    );
  }

  if (!data) return <CommandCenterSkeleton />;

  const op = OP_STATUS[data.operationalStatus];
  const totalSafety = data.safety.unacknowledgedCriticalLabs + data.safety.unverifiedCriticalImaging;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Command Center"
        description="Live operational status across the facility"
        actions={
          <span className={cn(
            "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12.5px] font-medium",
            data.operationalStatus === "green" ? "border-success/25 bg-success/10 text-success"
              : data.operationalStatus === "watch" ? "border-warning/25 bg-warning/10 text-warning"
              : "border-critical/30 bg-critical/12 text-critical"
          )}>
            <op.icon size={15} /> {op.label}
          </span>
        }
      />

      {/* Safety-critical banner takes visual priority when it matters. */}
      {totalSafety > 0 && (
        <Card className="border-critical/30 bg-critical/[0.06]">
          <div className="flex items-start gap-3">
            <ShieldAlert size={18} className="mt-0.5 shrink-0 text-critical" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-text-primary">Patient safety needs attention</p>
              <p className="mt-0.5 type-secondary">
                {data.safety.unacknowledgedCriticalLabs} unacknowledged critical labs · {data.safety.unverifiedCriticalImaging} unverified critical imaging
              </p>
            </div>
            <Badge tone="critical" className="shrink-0">{totalSafety}</Badge>
          </div>
        </Card>
      )}

      {/* Primary KPIs */}
      <section>
        <CardLabel className="mb-2">Today</CardLabel>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Admissions" value={data.today.admissions} deltaPct={data.today.admissionsDeltaPct} deltaLabel="vs 7-day avg" deltaGood={false} />
          <Stat label="Discharges" value={data.today.discharges} />
          <Stat label="ED visits" value={data.today.edVisits} />
          <Stat label="OPD visits" value={data.today.opdVisits} />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Appointments" value={data.access.appointmentsToday} />
          <Stat label="No-shows" value={data.access.noShowsToday} />
          <Stat label="OPD waiting" value={data.access.opdWaiting} />
          <Stat label="ED waiting" value={data.access.edWaiting} />
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {/* Alerts */}
          <Card>
            <CardHeader icon={<ShieldAlert />} title="Active alerts" action={<span className="text-[11px] text-text-tertiary tabular-nums">{data.alerts.length} active</span>} />
            <div className="mt-3 space-y-2">
              {data.alerts.length === 0 ? (
                <EmptyState
                  icon={<ShieldCheck />}
                  title="No active alerts"
                  description="The hospital is running within normal parameters."
                  className="py-8"
                />
              ) : (
                data.alerts.map((a) => (
                  <div key={a.id} className={cn(
                    "flex items-start gap-2.5 rounded-field border px-3 py-2.5 transition-colors",
                    a.severity === "critical" ? "border-critical/25 bg-critical/[0.05]"
                      : a.severity === "watch" ? "border-warning/25 bg-warning/[0.05]"
                      : "border-hairline hover:bg-fill-hover"
                  )}>
                    <AlertTriangle size={14} className={cn("mt-0.5 shrink-0", a.severity === "critical" ? "text-critical" : a.severity === "watch" ? "text-warning" : "text-info")} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[12.5px] text-text-primary">{a.message}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <Badge tone="neutral">{a.department}</Badge>
                        <span className="text-[10.5px] text-text-tertiary">owner: {a.ownerRole.replaceAll("_", " ").toLowerCase()}</span>
                      </div>
                    </div>
                    <StatusPill label={a.severity} tone={ALERT_TONE[a.severity]} className="shrink-0" />
                  </div>
                ))
              )}
            </div>
          </Card>

          {/* Patient flow */}
          <Card>
            <CardHeader icon={<Activity />} title="Patient flow" />
            <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5">
              {Object.entries(data.patientFlow).map(([stage, count]) => (
                <div key={stage} className="rounded-field border border-hairline bg-fill-subtle px-2 py-3 text-center">
                  <p className="type-metric text-[20px] text-text-primary">{count}</p>
                  <p className="mt-1 text-[10px] capitalize text-text-tertiary">{stage.replaceAll("_", " ").toLowerCase()}</p>
                </div>
              ))}
            </div>
          </Card>

          {/* Bed occupancy by ward */}
          <Card>
            <CardHeader icon={<BedDouble />} title="Bed occupancy by ward" />
            <div className="mt-3 space-y-3">
              {data.beds.byWard.map((w) => {
                const pct = w.total ? Math.round((w.occupied / w.total) * 100) : 0;
                return (
                  <div key={w.wardName}>
                    <div className="flex items-center justify-between text-[12px]">
                      <span className="text-text-primary">{w.wardName}</span>
                      <span className="tabular-nums text-text-tertiary">{w.occupied}/{w.total} · {pct}%</span>
                    </div>
                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-fill-muted">
                      <div className={cn("h-full rounded-full transition-[width] duration-500", pct >= 90 ? "bg-danger" : pct >= 70 ? "bg-warning" : "bg-success")} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          {/* Beds summary */}
          <Card>
            <CardHeader icon={<BedDouble />} title="Beds" action={<Link href="/hospital-os/beds" className="focus-ring flex items-center gap-0.5 rounded text-[11px] text-brand hover:underline">Board <ChevronRight size={12} /></Link>} />
            <p className="mt-2 type-metric text-text-primary">{data.beds.occupancyPct}<span className="text-[16px] text-text-tertiary">%</span></p>
            <p className="text-[11.5px] text-text-tertiary">{data.beds.available} available of {data.beds.total}</p>
            <div className="mt-3 space-y-1.5 border-t border-hairline pt-3">
              {Object.entries(data.beds.byStatus).map(([status, count]) => (
                <div key={status} className="flex items-center justify-between text-[11.5px]">
                  <span className="capitalize text-text-secondary">{status.replaceAll("_", " ").toLowerCase()}</span>
                  <span className="tabular-nums text-text-primary">{count}</span>
                </div>
              ))}
            </div>
          </Card>

          {/* Patient safety */}
          <Card>
            <CardHeader icon={<ShieldAlert />} title="Patient safety" />
            <div className="mt-3 space-y-2.5">
              <SafetyRow label="Unacknowledged critical labs" value={data.safety.unacknowledgedCriticalLabs} critical />
              <SafetyRow label="Unverified critical imaging" value={data.safety.unverifiedCriticalImaging} critical />
              <SafetyRow label="Pending discharges" value={data.safety.pendingDischarges} />
            </div>
          </Card>

          {/* ADT backlog */}
          <Card>
            <CardHeader title="ADT backlog" />
            <div className="mt-3 space-y-2.5">
              <SafetyRow label="Admission requests pending" value={data.patientFlowOps.admissionRequestsPending} />
              <SafetyRow label="Beds reserved, not admitted" value={data.patientFlowOps.admissionRequestsBedReserved} />
              <SafetyRow label="Transfer backlog" value={data.patientFlowOps.transferBacklog} />
              <SafetyRow label="Discharge-ready, still in bed" value={data.patientFlowOps.dischargeReadyNotLeft} />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function SafetyRow({ label, value, critical }: { label: string; value: number; critical?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12px] text-text-secondary">{label}</span>
      <Badge tone={value > 0 ? (critical ? "critical" : "warning") : "success"}>{value}</Badge>
    </div>
  );
}

function CommandCenterSkeleton() {
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex items-center justify-between">
        <div className="space-y-2"><Skeleton className="h-6 w-48" /><Skeleton className="h-4 w-64" /></div>
        <Skeleton className="h-8 w-36 rounded-full" />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[86px] rounded-surface" />)}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2"><Skeleton className="h-64 rounded-surface" /><Skeleton className="h-40 rounded-surface" /></div>
        <div className="space-y-4"><Skeleton className="h-40 rounded-surface" /><Skeleton className="h-40 rounded-surface" /></div>
      </div>
    </div>
  );
}
