"use client";

import { useCallback, useEffect, useState } from "react";
import { Workflow, RefreshCw, PlayCircle } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { StatusPill, type StatusTone } from "@/components/ui/StatusPill";
import { Button } from "@/components/ui/Button";
import { useToastStore } from "@/store/useToastStore";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Phase D7 — platform-only Workflow Operations panel. Renders NOTHING for
 * non-platform callers (every fetch is authorized server-side; a 403 hides the
 * section). Shows ENGINE metrics (execution/queue health), definitions, recent
 * instances, and a bounded tick control. NOT a workflow builder. Uses the existing
 * design system.
 */

async function api(url: string, init?: RequestInit) {
  const res = await fetch(url, { ...init, headers: init?.body ? { "Content-Type": "application/json" } : undefined });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

const healthTone = (h: string): StatusTone => (h === "CRITICAL" ? "danger" : h === "ATTENTION" ? "warning" : "success");
const instTone = (s: string): StatusTone =>
  s === "FAILED" ? "danger" : s === "CANCELLED" ? "warning" : s === "COMPLETED" ? "success" : s === "WAITING" ? "info" : "neutral";
const ms = (n: number) => (n < 1000 ? `${n}ms` : n < 60_000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n / 60_000)}m`);

export function WorkflowOperationsPanel() {
  const push = useToastStore((s) => s.push);
  const [metrics, setMetrics] = useState<any>(null);
  const [defs, setDefs] = useState<any[] | null>(null);
  const [instances, setInstances] = useState<any[] | null>(null);
  const [visible, setVisible] = useState(false);

  const load = useCallback(() => {
    api("/api/hospital/enterprise/workflow-ops/metrics").then(({ ok, data }) => {
      if (!ok) { setVisible(false); return; }
      setVisible(true); setMetrics(data);
    });
    api("/api/hospital/enterprise/workflows").then(({ ok, data }) => { if (ok) setDefs(data.definitions ?? []); });
    api("/api/hospital/enterprise/workflow-instances?limit=10").then(({ ok, data }) => { if (ok) setInstances(data.instances ?? []); });
  }, []);
  useEffect(() => { load(); }, [load]);

  async function tick() {
    const { ok, data } = await api("/api/hospital/enterprise/workflow-ops/tick", { method: "POST", body: "{}" });
    push(ok ? `Tick: ${JSON.stringify(data)}` : (data.error ?? "Tick failed."), ok ? "emerald" : "red");
    if (ok) load();
  }
  async function retry(id: string) {
    const { ok, data } = await api(`/api/hospital/enterprise/workflow-instances/${id}/retry`, { method: "POST", body: "{}" });
    push(ok ? "Retried" : (data.error ?? "Retry failed."), ok ? "emerald" : "red");
    if (ok) load();
  }

  if (!visible) return null;

  const inst = metrics?.instancesByStatus ?? {};

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Workflow size={16} className="text-brand" />
        <h2 className="text-[15px] font-semibold">Workflow operations</h2>
        <span className="text-[12px] text-text-tertiary">Orchestration engine across all organizations (platform-only)</span>
        {metrics && <StatusPill tone={healthTone(metrics.health)} label={metrics.health} />}
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="secondary" onClick={tick}><PlayCircle size={14} /> Tick</Button>
          <Button size="sm" variant="ghost" onClick={load}><RefreshCw size={14} /> Refresh</Button>
        </div>
      </div>

      {metrics && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Active definitions", value: metrics.activeDefinitions },
            { label: "Running / waiting", value: (inst.RUNNING ?? 0) + (inst.WAITING ?? 0) + (inst.RUNNABLE ?? 0) },
            { label: "Completed", value: inst.COMPLETED ?? 0 },
            { label: "Failed", value: metrics.failedInstances },
            { label: "Overdue tasks", value: metrics.overdueTasks },
            { label: "Pending timers", value: metrics.pendingTimers },
            { label: "Due timers", value: metrics.dueTimers },
            { label: "Avg latency", value: ms(metrics.avgLatencyMs) },
          ].map((k) => (
            <Card key={k.label} className="p-3">
              <div className="text-[11px] uppercase tracking-wide text-text-tertiary">{k.label}</div>
              <div className="mt-1 text-[18px] font-semibold tabular-nums">{k.value}</div>
            </Card>
          ))}
        </div>
      )}

      {defs && defs.length > 0 && (
        <Card className="p-3">
          <div className="mb-2 text-[12px] font-medium text-text-secondary">Definitions</div>
          <div className="flex flex-wrap gap-2">
            {defs.map((d: any) => (
              <StatusPill key={d.id} tone={d.status === "ACTIVE" ? "success" : "neutral"} dot={false} label={`${d.key} · ${d.triggerEventType}@${d.triggerEventVersion}`} />
            ))}
          </div>
        </Card>
      )}

      <Card className="p-3">
        <div className="mb-2 text-[12px] font-medium text-text-secondary">Recent instances</div>
        {!instances || instances.length === 0 ? (
          <div className="text-[12px] text-text-tertiary">No workflow instances yet.</div>
        ) : (
          <div className="space-y-2">
            {instances.map((i: any) => (
              <div key={i.id} className="flex items-center gap-2 rounded-lg border border-hairline p-2">
                <StatusPill tone={instTone(i.status)} dot={false} label={i.status} />
                <span className="truncate text-[12px] text-text-secondary">{i.definition?.key ?? i.workflowDefinitionId}</span>
                <span className="truncate text-[11px] text-text-tertiary">{i.aggregateType}:{i.aggregateId}</span>
                {i.status === "FAILED" && (
                  <Button className="ml-auto" size="sm" variant="secondary" onClick={() => retry(i.id)}>Retry</Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
