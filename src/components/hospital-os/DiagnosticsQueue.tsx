"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Stethoscope } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { DiagnosticPriorityBadge, DiagnosticStatusBadge, CriticalResultBanner } from "@/components/hospital-os/diagnostics/shared";

interface UnifiedItem {
  id: string;
  diagnosticType: "LAB" | "RADIOLOGY";
  sourceOrderId: string;
  title: string;
  patientId: string;
  patientName: string;
  uhid: string;
  priority: string;
  status: string;
  ageMinutes: number | null;
  isCritical: boolean;
}

interface CriticalItem {
  id: string;
  diagnosticType: "LAB" | "RADIOLOGY";
  patientId: string;
  patientName: string;
  encounterId: string;
  sourceOrderId: string;
  summary: string;
  createdAt: string;
  acknowledgedByStaffId: string | null;
  acknowledgedAt: string | null;
  ageMinutes: number;
}

interface WorklistResponse {
  items: UnifiedItem[];
  criticalItems: CriticalItem[];
  tat: { avgLabOrderToCollectionMinutes: number | null; avgImagingOrderToStudyCompletionMinutes: number | null };
  counts: { total: number; lab: number; radiology: number; critical: number };
}

const STATUSES = ["ORDERED", "SCHEDULED", "IN_PROGRESS", "AWAITING_RESULT", "AWAITING_VERIFICATION", "COMPLETED", "CRITICAL"];

/**
 * Unified Diagnostics workspace (Phase 4 Milestone D, brief §4) — the
 * entry point for diagnostic operations. Read-only overview + cross-domain
 * filtering + critical-item acknowledgement (calling the *existing*
 * lab/imaging acknowledge endpoints directly, no new mutation logic);
 * detailed operational actions (collect/schedule/verify/etc.) stay in the
 * dedicated /hospital-os/lab and /hospital-os/radiology workspaces this
 * page links out to.
 */
export function DiagnosticsQueue() {
  const push = useToastStore((s) => s.push);
  const [data, setData] = useState<WorklistResponse | null>(null);
  const urlParams = useSearchParams();
  // Initial filter state seeded from the URL (brief §9's Doctor Workspace
  // deep links, e.g. /hospital-os/diagnostics?type=LAB&status=CRITICAL) —
  // read once on mount, not re-synced on every navigation.
  const [type, setType] = useState<"ALL" | "LAB" | "RADIOLOGY">((urlParams.get("type")?.toUpperCase() as "LAB" | "RADIOLOGY") ?? "ALL");
  const [priority, setPriority] = useState(urlParams.get("priority") ?? "");
  const [status, setStatus] = useState(urlParams.get("status") ?? "");
  const [q, setQ] = useState("");

  function load() {
    const params = new URLSearchParams();
    params.set("type", type);
    if (priority) params.set("priority", priority);
    if (status) params.set("status", status);
    if (q.trim()) params.set("q", q.trim());
    fetch(`/api/hospital/orders/diagnostics/worklist?${params.toString()}`)
      .then((r) => r.json())
      .then((json: Omit<WorklistResponse, "criticalItems"> & { criticalItems: Omit<CriticalItem, "ageMinutes">[] }) => {
        // ageMinutes is computed once here (at fetch time), not inline during
        // render — Date.now() during render is an impure-render violation.
        const now = Date.now();
        setData({
          ...json,
          criticalItems: json.criticalItems.map((c) => ({ ...c, ageMinutes: Math.round((now - new Date(c.createdAt).getTime()) / 60000) })),
        });
      });
  }
  useEffect(load, [type, priority, status, q]);

  async function acknowledge(item: CriticalItem) {
    const url =
      item.diagnosticType === "LAB"
        ? `/api/hospital/orders/lab/${item.sourceOrderId}/acknowledge`
        : `/api/hospital/orders/imaging/${item.sourceOrderId}/report/${item.id}/acknowledge`;
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { push(json.error ?? "Action failed.", "red"); return; }
    push("Critical item acknowledged.", "emerald");
    load();
  }

  if (!data) return <div className="mx-auto max-w-5xl animate-pulse"><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;

  return (
    <div className="mx-auto max-w-5xl space-y-3">
      <ToastViewport />
      <div className="flex items-center gap-2"><Stethoscope size={18} className="text-cyan" /><h1 className="text-[20px] font-semibold tracking-tight">Diagnostics</h1></div>
      <p className="text-[13px] text-text-secondary">
        {data.counts.total} diagnostic items — {data.counts.lab} Lab, {data.counts.radiology} Radiology, {data.counts.critical} critical.
        {" "}<Link href="/hospital-os/lab" className="text-cyan hover:underline">Open Lab Worklist</Link>
        {" · "}<Link href="/hospital-os/radiology" className="text-cyan hover:underline">Open Radiology Worklist</Link>
      </p>

      <Card className="rounded-[20px]">
        <div className="flex flex-wrap items-center gap-2">
          {(["ALL", "LAB", "RADIOLOGY"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setType(t)}
              className={`rounded-md px-3 py-1.5 text-[11.5px] font-medium ${type === t ? "bg-cyan text-ink" : "border border-hairline text-text-secondary hover:border-cyan/40"}`}
            >
              {t}
            </button>
          ))}
          <select value={priority} onChange={(e) => setPriority(e.target.value)} className="rounded-md border border-hairline bg-black/[0.02] px-2 py-1.5 text-[11.5px]">
            <option value="">All priorities</option>
            <option value="ROUTINE">Routine</option>
            <option value="URGENT">Urgent</option>
            <option value="STAT">Stat</option>
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-md border border-hairline bg-black/[0.02] px-2 py-1.5 text-[11.5px]">
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
          </select>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search patient, UHID, test/study..." className="min-w-[200px] flex-1 rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[11.5px]" />
        </div>
      </Card>

      {data.criticalItems.length > 0 && (
        <Card className="rounded-[20px]">
          <p className="text-[13px] font-semibold text-red">Critical — unacknowledged</p>
          <div className="mt-2 space-y-2">
            {data.criticalItems.map((c) => (
              <CriticalResultBanner
                key={`${c.diagnosticType}-${c.id}`}
                diagnosticType={c.diagnosticType}
                patientName={c.patientName}
                summary={c.summary}
                ageMinutes={c.ageMinutes}
                onAcknowledge={() => acknowledge(c)}
              />
            ))}
          </div>
        </Card>
      )}

      <Card className="rounded-[20px]">
        <p className="text-[13px] font-semibold">Worklist</p>
        <div className="mt-2 space-y-1.5">
          {data.items.map((item) => (
            <Link
              key={item.id}
              href={item.diagnosticType === "LAB" ? "/hospital-os/lab" : "/hospital-os/radiology"}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-hairline px-3 py-2 hover:border-cyan/40"
            >
              <div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10.5px] font-medium text-text-tertiary">{item.diagnosticType}</span>
                  <p className="text-[12.5px] font-medium">{item.title}</p>
                </div>
                <p className="text-[11px] text-text-tertiary">{item.patientName} · {item.uhid}{item.ageMinutes != null ? ` · ${item.ageMinutes}m` : ""}</p>
              </div>
              <div className="flex items-center gap-1.5">
                <DiagnosticPriorityBadge priority={item.priority} />
                <DiagnosticStatusBadge status={item.status} />
              </div>
            </Link>
          ))}
          {data.items.length === 0 && <p className="text-[13px] text-text-tertiary">No diagnostic items match these filters.</p>}
        </div>
      </Card>

      {(data.tat.avgLabOrderToCollectionMinutes != null || data.tat.avgImagingOrderToStudyCompletionMinutes != null) && (
        <p className="text-[11px] text-text-tertiary">
          {data.tat.avgLabOrderToCollectionMinutes != null && <>Avg. order→collection: {data.tat.avgLabOrderToCollectionMinutes}m</>}
          {data.tat.avgLabOrderToCollectionMinutes != null && data.tat.avgImagingOrderToStudyCompletionMinutes != null && " · "}
          {data.tat.avgImagingOrderToStudyCompletionMinutes != null && <>Avg. order→study start: {data.tat.avgImagingOrderToStudyCompletionMinutes}m</>}
        </p>
      )}
    </div>
  );
}
