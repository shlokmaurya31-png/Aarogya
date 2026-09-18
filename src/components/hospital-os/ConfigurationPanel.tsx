"use client";

import { useCallback, useEffect, useState } from "react";
import { SlidersHorizontal, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { StatusPill, type StatusTone } from "@/components/ui/StatusPill";
import { Button } from "@/components/ui/Button";
import { useToastStore } from "@/store/useToastStore";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Phase D8 — configuration engine admin panel. Scoped to the caller's organization
 * (D1 membership + C4 apply server-side; a 403/404 simply hides content). Shows
 * effective values WITH provenance for the registry keys, and lets an authorized
 * admin set (draft) → publish → reset a key at the organization scope. Not a
 * workflow builder. Uses the existing design system.
 */

async function api(url: string, init?: RequestInit) {
  const res = await fetch(url, { ...init, headers: init?.body ? { "Content-Type": "application/json" } : undefined });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

const sourceTone = (s: string): StatusTone =>
  s === "DEPARTMENT" ? "brand" : s === "FACILITY" ? "info" : s === "ORGANIZATION" ? "success" : s === "SYSTEM" ? "neutral" : "warning";

export function ConfigurationPanel({ organizationId }: { organizationId: string | null }) {
  const push = useToastStore((s) => s.push);
  const [registry, setRegistry] = useState<any>(null);
  const [overrides, setOverrides] = useState<any[] | null>(null);
  const [key, setKey] = useState("sla.critical_result_ack");
  const [value, setValue] = useState("");
  const [effective, setEffective] = useState<any>(null);
  const [visible, setVisible] = useState(false);

  const load = useCallback(() => {
    if (!organizationId) return;
    api("/api/hospital/enterprise/configuration/registry").then(({ ok, data }) => {
      if (!ok) { setVisible(false); return; }
      setVisible(true); setRegistry(data);
    });
    api(`/api/hospital/enterprise/configuration?organizationId=${organizationId}`).then(({ ok, data }) => { if (ok) setOverrides(data.overrides ?? []); });
  }, [organizationId]);
  useEffect(() => { load(); }, [load]);

  const explain = useCallback(async () => {
    if (!organizationId || !key) return;
    const { ok, data } = await api(`/api/hospital/enterprise/configuration/effective?key=${encodeURIComponent(key)}&organizationId=${organizationId}`);
    if (ok) setEffective(data); else { setEffective(null); push(data.error ?? "Lookup failed.", "red"); }
  }, [organizationId, key, push]);

  async function op(label: string, path: string, body: any) {
    const { ok, data } = await api(`/api/hospital/enterprise/configuration/${path}`, { method: "POST", body: JSON.stringify(body) });
    push(ok ? `${label} ok` : (data.error ?? `${label} failed.`), ok ? "emerald" : "red");
    if (ok) { load(); explain(); }
  }

  if (!visible || !organizationId) return null;
  const base = { key, scope: "ORGANIZATION", organizationId };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <SlidersHorizontal size={16} className="text-brand" />
        <h2 className="text-[15px] font-semibold">Configuration</h2>
        <span className="text-[12px] text-text-tertiary">Hospital-specific behavior via validated, versioned configuration (SYSTEM → ORG → FACILITY → DEPARTMENT)</span>
        <Button className="ml-auto" size="sm" variant="ghost" onClick={load}><RefreshCw size={14} /> Refresh</Button>
      </div>

      <Card className="p-3 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="configuration key"
            className="min-w-[240px] flex-1 rounded-lg border border-hairline bg-surface px-2 py-1 text-[12px]" />
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="value (e.g. 15m, true, STAT)"
            className="w-[180px] rounded-lg border border-hairline bg-surface px-2 py-1 text-[12px]" />
          <Button size="sm" variant="ghost" onClick={explain}>Explain</Button>
          <Button size="sm" variant="secondary" onClick={() => op("Set draft", "set", { ...base, value })}>Set draft</Button>
          <Button size="sm" variant="secondary" onClick={() => op("Publish", "publish", base)}>Publish</Button>
          <Button size="sm" variant="ghost" onClick={() => op("Reset", "reset", base)}>Reset</Button>
        </div>

        {effective && (
          <div className="rounded-lg border border-hairline p-2 text-[12px]">
            <div className="flex items-center gap-2">
              <span className="font-medium">{effective.key}</span>
              <span className="text-text-secondary">= {effective.raw ?? "—"} ({effective.valueType})</span>
              <StatusPill tone={sourceTone(effective.source)} dot={false} label={`${effective.source}${effective.version ? " v" + effective.version : ""}`} />
            </div>
            <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-text-tertiary">
              {(effective.chain ?? []).map((c: any, i: number) => (
                <span key={i} className={c.present ? "text-text-secondary" : "opacity-50"}>
                  {c.source}: {c.present ? (c.raw ?? "set") : "—"}{i < effective.chain.length - 1 ? " ›" : ""}
                </span>
              ))}
            </div>
          </div>
        )}
      </Card>

      <Card className="p-3">
        <div className="mb-2 text-[12px] font-medium text-text-secondary">Overrides in this organization</div>
        {!overrides || overrides.length === 0 ? (
          <div className="text-[12px] text-text-tertiary">No overrides yet — all keys use their inherited / system default.</div>
        ) : (
          <div className="space-y-1">
            {overrides.map((o: any) => (
              <div key={o.id} className="flex items-center gap-2 rounded-lg border border-hairline p-2 text-[12px]">
                <StatusPill tone={o.status === "PUBLISHED" ? "success" : o.status === "DRAFT" ? "warning" : "neutral"} dot={false} label={o.status} />
                <span className="truncate font-medium">{o.key}</span>
                <span className="text-text-tertiary">{o.scope}</span>
                <span className="ml-auto text-text-secondary">{o.value}{o.version ? ` · v${o.version}` : ""}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {registry && (
        <div className="text-[11px] text-text-tertiary">
          {registry.exact.length} exact keys · {registry.templates.length} templated key families available.
        </div>
      )}
    </div>
  );
}
