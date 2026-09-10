"use client";

import { useCallback, useEffect, useState } from "react";
import { Wrench, Sparkles, Utensils, Truck, Ambulance, HardHat, Cpu, ShieldAlert, Activity } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Tab = "overview" | "housekeeping" | "dietary" | "transport" | "ambulance" | "maintenance" | "biomedical" | "infection";

function Metric({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "red" | "amber" | "cyan" | "neutral" | "emerald" }) {
  const color = tone === "red" ? "text-red" : tone === "amber" ? "text-amber" : tone === "cyan" ? "text-cyan" : tone === "emerald" ? "text-emerald" : "";
  return (
    <div className="rounded-xl border border-hairline px-3 py-2 min-w-[92px]">
      <p className={`text-[19px] font-semibold leading-none ${color}`}>{value}</p>
      <p className="mt-1 text-[10px] uppercase tracking-[0.1em] text-text-tertiary">{label}</p>
    </div>
  );
}
const ENDPOINTS: Record<Exclude<Tab, "overview">, { url: string; key: string }> = {
  housekeeping: { url: "/api/hospital/operations/housekeeping", key: "requests" },
  dietary: { url: "/api/hospital/operations/meals", key: "meals" },
  transport: { url: "/api/hospital/operations/transport", key: "requests" },
  ambulance: { url: "/api/hospital/operations/ambulance-trips", key: "trips" },
  maintenance: { url: "/api/hospital/operations/maintenance", key: "requests" },
  biomedical: { url: "/api/hospital/operations/equipment", key: "equipment" },
  infection: { url: "/api/hospital/operations/infection", key: "incidents" },
};
const tone = (s: string): "emerald" | "amber" | "red" | "cyan" | "neutral" =>
  ["COMPLETED", "CLOSED", "DELIVERED", "RESOLVED", "VERIFIED", "IN_SERVICE", "AVAILABLE", "DONE"].includes(s) ? "emerald"
    : ["CANCELLED", "REJECTED", "REFUSED", "MISSED", "OUT_OF_SERVICE", "FAILED_DISPATCH"].includes(s) ? "red"
    : ["REQUESTED", "REPORTED", "PLANNED", "SCHEDULED"].includes(s) ? "neutral" : "cyan";

export function OperationsWorkspace() {
  const push = useToastStore((s) => s.push);
  const [tab, setTab] = useState<Tab>("overview");
  const [cc, setCc] = useState<any>(null);
  const [rows, setRows] = useState<any[] | null>(null);

  const loadCc = useCallback(() => { fetch("/api/hospital/operations/command-center").then((r) => r.json()).then((d) => setCc(d.commandCenter ?? null)); }, []);
  useEffect(loadCc, [loadCc]);

  const loadRows = useCallback((t: Tab) => {
    if (t === "overview") return;
    const e = ENDPOINTS[t];
    fetch(e.url).then((r) => r.json()).then((d) => setRows(d[e.key] ?? []));
  }, []);
  useEffect(() => { loadRows(tab); }, [tab, loadRows]);

  async function post(url: string, body: unknown, ok: string) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { push(data.error ?? "Failed.", "red"); return false; }
    push(ok, "emerald"); loadCc(); loadRows(tab); return true;
  }

  // next-status maps for the primary "advance" action
  const NEXT: Record<string, Record<string, string>> = {
    housekeeping: { REQUESTED: "ASSIGNED", ASSIGNED: "IN_PROGRESS", IN_PROGRESS: "COMPLETED", COMPLETED: "INSPECTED", INSPECTED: "CLOSED" },
    dietary: { PLANNED: "PREPARING", PREPARING: "READY", READY: "DELIVERED" },
    transport: { REQUESTED: "ASSIGNED", ASSIGNED: "EN_ROUTE_TO_PICKUP", EN_ROUTE_TO_PICKUP: "PATIENT_PICKED_UP", PATIENT_PICKED_UP: "IN_TRANSIT", IN_TRANSIT: "ARRIVED", ARRIVED: "COMPLETED" },
    ambulance: { DISPATCHED: "EN_ROUTE", EN_ROUTE: "AT_PICKUP", AT_PICKUP: "PATIENT_ONBOARD", PATIENT_ONBOARD: "IN_TRANSIT", IN_TRANSIT: "ARRIVED", ARRIVED: "COMPLETED" },
    maintenance: { REPORTED: "ASSIGNED", TRIAGED: "ASSIGNED", ASSIGNED: "IN_PROGRESS", IN_PROGRESS: "RESOLVED", RESOLVED: "VERIFIED", VERIFIED: "CLOSED" },
    infection: { REPORTED: "UNDER_REVIEW", UNDER_REVIEW: "INVESTIGATION", INVESTIGATION: "ACTION_REQUIRED", ACTION_REQUIRED: "RESOLVED", RESOLVED: "CLOSED" },
  };
  const STATUS_URL: Record<string, (r: any) => string> = {
    housekeeping: (r) => `/api/hospital/operations/housekeeping/${r.id}/status`,
    dietary: (r) => `/api/hospital/operations/meals/${r.id}/status`,
    transport: (r) => `/api/hospital/operations/transport/${r.id}/status`,
    ambulance: (r) => `/api/hospital/operations/ambulance-trips/${r.id}/status`,
    maintenance: (r) => `/api/hospital/operations/maintenance/${r.id}/status`,
    infection: (r) => `/api/hospital/operations/infection/${r.id}/status`,
  };

  function rowLabel(t: Tab, r: any): string {
    if (t === "housekeeping") return `${r.requestType} · ${r.bedId ? "bed " + r.bedId.slice(-6) : r.areaLabel ?? "area"}`;
    if (t === "dietary") return `${r.mealPeriod} · patient ${r.patientId.slice(-6)}`;
    if (t === "transport") return `${r.transportType} · patient ${r.patientId.slice(-6)}`;
    if (t === "ambulance") return `${r.origin} → ${r.destination}`;
    if (t === "maintenance") return `${r.issueType} · ${r.description?.slice(0, 40) ?? ""}`;
    if (t === "biomedical") return `${r.assetTag} · ${r.category}${r.locationLabel ? " · " + r.locationLabel : ""}`;
    if (t === "infection") return `${r.incidentType}${r.isolationRequired ? " · ISOLATION" : ""}${r.wardId ? " · ward " + r.wardId.slice(-6) : ""}`;
    return r.id;
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <ToastViewport />
      <div className="flex items-center gap-2">
        <Wrench size={18} className="text-cyan" />
        <h1 className="text-[20px] font-semibold tracking-tight">Hospital Operations</h1>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {([["overview", "Command Center", Activity], ["housekeeping", "Housekeeping", Sparkles], ["dietary", "Dietary", Utensils], ["transport", "Transport", Truck], ["ambulance", "Ambulance", Ambulance], ["maintenance", "Maintenance", HardHat], ["biomedical", "Biomedical", Cpu], ["infection", "Infection Control", ShieldAlert]] as const).map(([t, label, Icon]) => (
          <button key={t} onClick={() => setTab(t)} className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] ${tab === t ? "border-cyan/40 bg-cyan/5 text-cyan" : "border-hairline text-text-secondary hover:border-hairline-strong"}`}>
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>

      {tab === "overview" && cc && (
        <div className="space-y-3">
          <Card className="rounded-[20px]"><CardLabel>Housekeeping</CardLabel><div className="mt-2 flex flex-wrap gap-2"><Metric label="Pending" value={cc.housekeeping.pending} tone="amber" /><Metric label="In progress" value={cc.housekeeping.inProgress} tone="cyan" /><Metric label="Overdue" value={cc.housekeeping.overdue} tone="red" /><Metric label="Awaiting inspect" value={cc.housekeeping.awaitingInspection} /></div></Card>
          <div className="grid gap-3 md:grid-cols-2">
            <Card className="rounded-[20px]"><CardLabel>Dietary</CardLabel><div className="mt-2 flex flex-wrap gap-2"><Metric label="Pending" value={cc.dietary.pending} tone="amber" /><Metric label="Ready" value={cc.dietary.ready} tone="cyan" /><Metric label="Missed/refused" value={cc.dietary.missedRefused} tone="red" /></div></Card>
            <Card className="rounded-[20px]"><CardLabel>Transport</CardLabel><div className="mt-2 flex flex-wrap gap-2"><Metric label="Pending" value={cc.transport.pending} tone="amber" /><Metric label="Active" value={cc.transport.active} tone="cyan" /><Metric label="Overdue" value={cc.transport.overdue} tone="red" /></div></Card>
            <Card className="rounded-[20px]"><CardLabel>Ambulance</CardLabel><div className="mt-2 flex flex-wrap gap-2"><Metric label="Available" value={cc.ambulance.available} tone="emerald" /><Metric label="On trip" value={cc.ambulance.onTrip} tone="cyan" /><Metric label="Unavailable" value={cc.ambulance.unavailable} tone="red" /></div></Card>
            <Card className="rounded-[20px]"><CardLabel>Maintenance</CardLabel><div className="mt-2 flex flex-wrap gap-2"><Metric label="Open" value={cc.maintenance.open} tone="amber" /><Metric label="Urgent" value={cc.maintenance.urgent} tone="red" /><Metric label="Overdue" value={cc.maintenance.overdue} tone="red" /></div></Card>
            <Card className="rounded-[20px]"><CardLabel>Biomedical</CardLabel><div className="mt-2 flex flex-wrap gap-2"><Metric label="Out of service" value={cc.biomedical.outOfService} tone="red" /><Metric label="Calibration due" value={cc.biomedical.calibrationDue} tone="amber" /><Metric label="PM due" value={cc.biomedical.preventiveDue} tone="amber" /></div></Card>
            <Card className="rounded-[20px]"><CardLabel>Infection Control</CardLabel><div className="mt-2 flex flex-wrap gap-2"><Metric label="Open" value={cc.infectionControl.open} tone="amber" /><Metric label="Investigation" value={cc.infectionControl.investigation} tone="cyan" /><Metric label="Action req." value={cc.infectionControl.actionRequired} tone="red" /></div></Card>
          </div>
        </div>
      )}

      {tab !== "overview" && (
        <Card className="rounded-[20px]">
          <CardLabel>{tab} queue</CardLabel>
          <div className="mt-2 space-y-1.5">
            {!rows && <div className="h-24 animate-pulse rounded-xl bg-black/[0.04]" />}
            {rows && rows.length === 0 && <p className="text-[13px] text-text-tertiary">No records.</p>}
            {rows?.map((r: any) => {
              const nextMap = NEXT[tab] ?? {};
              const next = nextMap[r.status];
              return (
                <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-1.5 text-[12.5px]">
                  <span className="min-w-0 truncate">{rowLabel(tab, r)}</span>
                  <span className="flex items-center gap-1.5">
                    {tab === "biomedical" && r.calibrationStatus && <StatusPill label={r.calibrationStatus} tone={r.calibrationStatus === "CALIBRATED" ? "emerald" : "amber"} className="rounded-md" />}
                    <StatusPill label={String(r.status).replace(/_/g, " ")} tone={tone(r.status)} className="rounded-md" />
                    {tab === "ambulance" && r.status === "REQUESTED" && <span className="text-[10.5px] text-text-tertiary">assign an ambulance to dispatch</span>}
                    {next && STATUS_URL[tab] && <button onClick={() => post(STATUS_URL[tab](r), { to: next }, `→ ${next.replace(/_/g, " ")}`)} className="rounded-md border border-hairline-strong px-2 py-0.5 text-[10.5px] hover:border-cyan/40 hover:text-cyan">→ {next.replace(/_/g, " ")}</button>}
                    {tab === "biomedical" && r.status === "IN_SERVICE" && <button onClick={() => post(`/api/hospital/operations/equipment/${r.id}/status`, { to: "OUT_OF_SERVICE" }, "Marked out of service.")} className="rounded-md border border-hairline-strong px-2 py-0.5 text-[10.5px] hover:border-red/40 hover:text-red">Out of service</button>}
                  </span>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
