"use client";

import { Card } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";

/**
 * Shared Diagnostics UI (Phase 4 Milestone D, brief §20) — extracted from
 * what were byte-identical `SectionCard`/`ActionButton` (and near-identical
 * `Row`) definitions duplicated in LabQueue.tsx and RadiologyQueue.tsx.
 * Both now import from here instead of their own copies. New badge
 * components below are additive — used by the new unified DiagnosticsQueue
 * and Patient Chart, not forced onto Lab/Radiology's own worklist rows.
 */

export interface PatientRef {
  fullName: string;
  uhid: string;
}

export function SectionCard({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <Card className="rounded-[20px]">
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-semibold">{title}</p>
        <StatusPill label={String(count)} tone="neutral" className="rounded-md" />
      </div>
      <div className="mt-2.5 space-y-2">{children}</div>
    </Card>
  );
}

export function Row({ patient, title, meta, ageMinutes, children }: { patient: PatientRef; title: string; meta: string; ageMinutes: number | null; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-hairline px-3 py-2">
      <div>
        <p className="text-[12.5px] font-medium">{title}</p>
        <p className="text-[11px] text-text-tertiary">{patient.fullName} · {patient.uhid} · {meta}{ageMinutes != null ? ` · ${ageMinutes}m` : ""}</p>
      </div>
      <div className="flex items-center gap-1.5">{children}</div>
    </div>
  );
}

export function ActionButton({ label, onClick, tone = "neutral" }: { label: string; onClick: () => void; tone?: "neutral" | "red" | "emerald" }) {
  const toneClass = tone === "red" ? "bg-red/10 text-red hover:bg-red/20" : tone === "emerald" ? "bg-emerald text-white hover:brightness-110" : "border border-hairline text-text-secondary hover:border-cyan/40 hover:text-cyan";
  return (
    <button onClick={onClick} className={`rounded-md px-2.5 py-1.5 text-[11px] font-medium ${toneClass}`}>
      {label}
    </button>
  );
}

/** Priority presentation consistent across Lab and Radiology (brief §6) — reads the same free-text priority field both domains already share. */
export function DiagnosticPriorityBadge({ priority, className }: { priority: string; className?: string }) {
  const tone = priority === "STAT" || priority === "EMERGENCY" ? "red" : priority === "URGENT" ? "amber" : "neutral";
  return <StatusPill label={priority} tone={tone} className={className ?? "rounded-md"} />;
}

/** Presentation for the shared DiagnosticStatus (brief §5) — never a substitute for the real domain status, just how it's shown. */
export function DiagnosticStatusBadge({ status, className }: { status: string; className?: string }) {
  const tone =
    status === "CRITICAL" ? "red" :
    status === "AWAITING_VERIFICATION" ? "amber" :
    status === "COMPLETED" ? "emerald" :
    status === "IN_PROGRESS" || status === "AWAITING_RESULT" ? "cyan" :
    "neutral";
  return <StatusPill label={status.replace(/_/g, " ")} tone={tone} className={className ?? "rounded-md"} />;
}

export function AmendmentBadge({ version, className }: { version: number; className?: string }) {
  if (version <= 1) return null;
  return <StatusPill label={`amended v${version}`} tone="cyan" className={className ?? "rounded-md"} />;
}

export function VerificationBadge({ status, className }: { status: string; className?: string }) {
  if (status !== "VERIFIED") return null;
  return <StatusPill label="verified" tone="emerald" className={className ?? "rounded-md"} />;
}

/** Structured critical-item banner (brief §10) — patient/source/severity/ack-status as real fields, not a message string. */
export function CriticalResultBanner({
  diagnosticType,
  patientName,
  summary,
  ageMinutes,
  onAcknowledge,
}: {
  diagnosticType: "LAB" | "RADIOLOGY";
  patientName: string;
  summary: string;
  ageMinutes: number | null;
  onAcknowledge: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red/30 bg-red/5 px-3 py-2">
      <div>
        <div className="flex items-center gap-1.5">
          <StatusPill label={diagnosticType} tone="red" className="rounded-md" />
          <p className="text-[12.5px] font-medium">{patientName}</p>
        </div>
        <p className="mt-0.5 text-[11px] text-text-tertiary">{summary}{ageMinutes != null ? ` · ${ageMinutes}m ago` : ""}</p>
      </div>
      <ActionButton label="Acknowledge" tone="red" onClick={onAcknowledge} />
    </div>
  );
}
