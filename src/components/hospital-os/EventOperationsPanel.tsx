"use client";

import { useCallback, useEffect, useState } from "react";
import { Radio, AlertTriangle, RefreshCw, PlayCircle } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { StatusPill, type StatusTone } from "@/components/ui/StatusPill";
import { Button } from "@/components/ui/Button";
import { useToastStore } from "@/store/useToastStore";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Phase D6 — platform-only Event Operations panel. Renders NOTHING for non-platform
 * callers (every fetch is authorized server-side; a 403 hides the section). These
 * are EVENT-SYSTEM metrics (delivery/queue health), never business KPIs. Payloads
 * shown are safe by construction (identifiers + metadata; the emit guard forbids
 * secrets/PHI). Uses the existing design system.
 */

async function api(url: string, init?: RequestInit) {
  const res = await fetch(url, { ...init, headers: init?.body ? { "Content-Type": "application/json" } : undefined });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

const healthTone = (h: string): StatusTone => (h === "CRITICAL" ? "danger" : h === "ATTENTION" ? "warning" : "success");
const statusTone = (s: string): StatusTone =>
  s === "DEAD_LETTER" ? "danger" : s === "RETRY" ? "warning" : s === "PROCESSED" ? "success" : "neutral";
const ms = (n: number) => (n < 1000 ? `${n}ms` : n < 60_000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n / 60_000)}m`);

export function EventOperationsPanel() {
  const push = useToastStore((s) => s.push);
  const [metrics, setMetrics] = useState<any>(null);
  const [deadLetters, setDeadLetters] = useState<any[] | null>(null);
  const [visible, setVisible] = useState(false);

  const load = useCallback(() => {
    api("/api/hospital/enterprise/events/metrics").then(({ ok, data }) => {
      if (!ok) { setVisible(false); return; }
      setVisible(true); setMetrics(data);
    });
    api("/api/hospital/enterprise/events/dead-letters").then(({ ok, data }) => { if (ok) setDeadLetters(data.deadLetters ?? []); });
  }, []);
  useEffect(() => { load(); }, [load]);

  async function post(label: string, url: string) {
    const { ok, data } = await api(url, { method: "POST", body: "{}" });
    push(ok ? `${label}: ${JSON.stringify(data)}` : (data.error ?? `${label} failed.`), ok ? "emerald" : "red");
    if (ok) load();
  }

  if (!visible) return null;

  const byStatus = metrics?.byStatus ?? {};
  const byType: [string, number][] = Object.entries(metrics?.byType ?? {});

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Radio size={16} className="text-brand" />
        <h2 className="text-[15px] font-semibold">Event operations</h2>
        <span className="text-[12px] text-text-tertiary">Domain-event delivery health across all organizations (platform-only)</span>
        {metrics && <StatusPill tone={healthTone(metrics.health)} label={metrics.health} />}
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => post("Dispatch", "/api/hospital/enterprise/events/dispatch")}>
            <PlayCircle size={14} /> Dispatch
          </Button>
          <Button size="sm" variant="ghost" onClick={load}><RefreshCw size={14} /> Refresh</Button>
        </div>
      </div>

      {metrics && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Pending", value: (byStatus.PENDING ?? 0) + (byStatus.RETRY ?? 0) },
            { label: "Processed", value: byStatus.PROCESSED ?? 0 },
            { label: "Dead letters", value: metrics.deadLetters },
            { label: "Oldest pending", value: ms(metrics.oldestPendingAgeMs) },
            { label: "Avg latency", value: ms(metrics.avgProcessingLatencyMs) },
          ].map((k) => (
            <Card key={k.label} className="p-3">
              <div className="text-[11px] uppercase tracking-wide text-text-tertiary">{k.label}</div>
              <div className="mt-1 text-[18px] font-semibold tabular-nums">{k.value}</div>
            </Card>
          ))}
        </div>
      )}

      {byType.length > 0 && (
        <Card className="p-3">
          <div className="mb-2 text-[12px] font-medium text-text-secondary">Events by type</div>
          <div className="flex flex-wrap gap-2">
            {byType.sort((a, b) => b[1] - a[1]).map(([t, n]) => (
              <StatusPill key={t} tone="neutral" dot={false} label={`${t} · ${n}`} />
            ))}
          </div>
        </Card>
      )}

      <Card className="p-3">
        <div className="mb-2 flex items-center gap-2 text-[12px] font-medium text-text-secondary">
          <AlertTriangle size={14} className={deadLetters && deadLetters.length ? "text-danger" : "text-text-tertiary"} />
          Dead-letter queue
        </div>
        {!deadLetters || deadLetters.length === 0 ? (
          <div className="text-[12px] text-text-tertiary">No dead-lettered events.</div>
        ) : (
          <div className="space-y-2">
            {deadLetters.map((e: any) => (
              <div key={e.eventId} className="flex items-center gap-2 rounded-lg border border-hairline p-2">
                <StatusPill tone={statusTone(e.status)} dot={false} label={`${e.eventType}@${e.eventVersion}`} />
                <span className="truncate text-[12px] text-text-tertiary">{e.lastErrorCode}: {e.lastErrorMessage}</span>
                <Button className="ml-auto" size="sm" variant="secondary" onClick={() => post("Retry", `/api/hospital/enterprise/events/${e.eventId}/retry`)}>
                  Retry
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
