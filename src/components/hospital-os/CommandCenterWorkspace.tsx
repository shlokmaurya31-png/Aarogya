"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, RefreshCw, AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { StatusPill, type StatusTone } from "@/components/ui/StatusPill";
import { Button } from "@/components/ui/Button";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Phase D10 — Hospital Command Center 2.0. An operational control surface: every metric
 * shows status + value + a WHY (drivers) + a drill-down, with an attention queue,
 * freshness (asOf), and explicit unavailable-state handling. Read-only; all data is
 * server-derived and tenant-scoped. Uses the existing design system.
 */

async function api(url: string) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

const statusTone = (s: string): StatusTone =>
  s === "CRITICAL" ? "critical" : s === "WARNING" ? "danger" : s === "WATCH" ? "warning" : s === "NORMAL" ? "success" : s === "UNAVAILABLE" ? "warning" : "neutral";
const sevTone = (s: string): StatusTone => (s === "CRITICAL" ? "critical" : s === "WARNING" ? "danger" : "warning");
const fmt = (v: number | null, unit: string) => (v === null ? "—" : `${v.toLocaleString("en-IN")}${unit && unit.length <= 2 ? unit : unit ? " " + unit : ""}`);
const time = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "—");

const WINDOWS = [
  { key: "24h", label: "24h" }, { key: "today", label: "Today" }, { key: "7d", label: "7d" }, { key: "30d", label: "30d" },
];

export function CommandCenterWorkspace() {
  const [overview, setOverview] = useState<any>(null);
  const [window, setWindow] = useState("24h");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const fetchOverview = useCallback(() => {
    return api(`/api/hospital/command-center/overview?window=${window}`).then(({ ok, data }) => {
      if (!ok) { setError(data.error ?? "Command Center unavailable."); setOverview(null); return; }
      setError(null); setOverview(data);
    });
  }, [window]);
  useEffect(() => { fetchOverview(); }, [fetchOverview]);
  const refresh = async () => { setLoading(true); try { await fetchOverview(); } finally { setLoading(false); } };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Activity size={18} className="text-brand" />
        <h1 className="text-[17px] font-semibold">Command Center</h1>
        {overview && <StatusPill tone={statusTone(overview.overallStatus)} label={overview.overallStatus} />}
        <span className="text-[12px] text-text-tertiary">as of {time(overview?.asOf)} · {overview?.window?.label ?? ""}</span>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex rounded-lg border border-hairline overflow-hidden">
            {WINDOWS.map((w) => (
              <button key={w.key} onClick={() => setWindow(w.key)} className={`px-2 py-1 text-[12px] ${window === w.key ? "bg-brand/10 text-brand" : "hover:bg-fill-hover"}`}>{w.label}</button>
            ))}
          </div>
          <Button size="sm" variant="ghost" onClick={refresh} loading={loading}><RefreshCw size={14} /> Refresh</Button>
        </div>
      </div>

      {error && <Card className="p-3 text-[13px] text-danger">{error}</Card>}

      {/* Attention queue */}
      {overview?.attention?.length > 0 && (
        <Card className="p-3">
          <div className="mb-2 flex items-center gap-2 text-[12px] font-medium text-text-secondary"><AlertTriangle size={14} className="text-warning" /> Operational attention</div>
          <div className="space-y-1">
            {overview.attention.map((a: any) => (
              <div key={a.key} className="flex flex-wrap items-center gap-2 rounded-lg border border-hairline p-2 text-[12px]">
                <StatusPill tone={sevTone(a.severity)} dot={false} label={a.severity} />
                <span className="font-medium">{a.title}</span>
                <span className="text-text-tertiary">— {a.reason}</span>
                {a.drillDown && <a href={a.drillDown} target="_blank" rel="noreferrer" className="ml-auto text-brand hover:underline">inspect</a>}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Section grid */}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {overview?.sections?.map((s: any) => {
          const open = expanded[s.key];
          return (
            <Card key={s.key} className="p-3">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-semibold">{s.label}</span>
                <StatusPill tone={statusTone(s.status)} dot={false} label={s.status} />
                <span className="ml-auto text-[10px] text-text-tertiary">as of {time(s.asOf)}</span>
              </div>

              {s.unavailable ? (
                <div className="mt-2 text-[12px] text-warning">Data unavailable — {s.unavailable.reason}</div>
              ) : (
                <>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {s.metrics.slice(0, 4).map((m: any) => (
                      <div key={m.key} className="rounded-lg border border-hairline p-2">
                        <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-text-tertiary">{m.label}</div>
                        <div className="mt-0.5 flex items-center gap-1">
                          <span className="text-[16px] font-semibold tabular-nums">{fmt(m.value, m.unit)}</span>
                          {m.status !== "NORMAL" && m.status !== "UNKNOWN" && <StatusPill tone={statusTone(m.status)} dot={false} label={m.status} />}
                        </div>
                        {m.threshold?.source === "D8_CONFIG" && <div className="text-[10px] text-text-tertiary">configured threshold</div>}
                      </div>
                    ))}
                  </div>
                  <button onClick={() => setExpanded((e) => ({ ...e, [s.key]: !e[s.key] }))} className="mt-2 flex items-center gap-1 text-[12px] text-brand hover:underline">
                    {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Why?
                  </button>
                  {open && (
                    <div className="mt-1 space-y-0.5">
                      {s.drivers.filter((d: any) => d.kind !== "UNAVAILABLE").map((d: any, i: number) => (
                        <div key={i} className="flex items-center gap-2 text-[11px]">
                          <span className={d.kind === "DIRECT" ? "text-text-secondary" : "text-text-tertiary"}>{d.kind === "DIRECT" ? "•" : "◦"}</span>
                          <span className="text-text-secondary">{d.label}</span>
                          <span className="ml-auto tabular-nums font-medium">{typeof d.value === "number" ? d.value.toLocaleString("en-IN") : d.value}</span>
                          {d.drillDown && <a href={d.drillDown} target="_blank" rel="noreferrer" className="text-brand hover:underline">↗</a>}
                        </div>
                      ))}
                      {s.drivers.filter((d: any) => d.kind === "UNAVAILABLE").map((d: any, i: number) => (
                        <div key={`u${i}`} className="text-[11px] text-text-tertiary italic">{d.label}: {d.value}</div>
                      ))}
                      {s.drillDown && <a href={s.drillDown} target="_blank" rel="noreferrer" className="mt-1 inline-block text-[11px] text-brand hover:underline">Open drill-down →</a>}
                    </div>
                  )}
                </>
              )}
            </Card>
          );
        })}
      </div>

      {overview?.restrictedSections?.length > 0 && (
        <div className="text-[11px] text-text-tertiary">Restricted (insufficient permission): {overview.restrictedSections.join(", ")}</div>
      )}
    </div>
  );
}
