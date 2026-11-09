"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ShieldAlert } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";

/**
 * Flagship 4b — the charge nurse's offline queue (docs/OFFLINE_NURSING_DESIGN.md
 * §13.3): possible double doses and PRN limits breached first, then refused
 * claims and records, and doses taken over from a device until confirmed in
 * person. Each action needs a reason and is audited. A CRITICAL item open 15
 * minutes is escalated to the pharmacists.
 */
interface Person { patientId: string; name: string; uhid: string }
interface QueueConflict {
  conflictId: string; kind: string; severity: "CRITICAL" | "WARNING"; raisedAt: string; dueAt: string | null; escalatedAt: string | null; overdue: boolean;
  patient: Person | null; drug: string | null; device: string | null; nurse: string | null;
  command: { kind: string; outcome: string; refusalReason: string | null; recordedAt: string; receivedAt: string; note: string | null };
}
interface QueueOverride { leaseId: string; takenOverAt: string | null; takenOverBy: string | null; reason: string | null; deviceSynced: boolean; device: string | null; patient: Person | null; drug: string | null; scheduledAt: string | null; doseStatus: string | null }
interface Queue { wardIds: string[]; conflicts: QueueConflict[]; overrides: QueueOverride[] }

const KIND_TEXT: Record<string, string> = {
  POSSIBLE_DOUBLE_DOSE: "Possible double dose", PRN_LIMIT_BREACHED: "As-needed dose over its limit", PRN_BREACH_ATTEMPT: "As-needed dose refused offline for its limits",
  ORDER_CHANGED: "Given after the order changed", LEASE_OVERRIDDEN: "Given after it was taken over", LEASE_EXPIRED: "Recorded after the offline limit",
  NOT_LEASED: "Not held by that device", ONLINE_ONLY: "Online-only medicine recorded offline", CLOCK_SUSPECT: "The device's clock looked wrong", REFUSED_RECORD: "A record that couldn't be applied",
};
const RESOLUTIONS: [string, string][] = [
  ["NO_HARM_FOUND", "Patient checked: no harm"], ["INCIDENT_RAISED", "Incident raised"], ["DUPLICATE_RECORD", "One dose, recorded twice"],
  ["RECORD_STANDS", "The record stands"], ["RECORDED_ONLINE", "Recorded online by me"],
];
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—");

export function OfflineConflictQueue() {
  const push = useToastStore((s) => s.push);
  const [queue, setQueue] = useState<Queue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [resolution, setResolution] = useState("NO_HARM_FOUND");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    fetch("/api/hospital/offline/conflicts").then(async (r) => (r.ok ? setQueue(await r.json()) : setError((await r.json().catch(() => null))?.error ?? "The queue is unavailable.")))
      .catch(() => setError("The queue is unavailable."));
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  async function act(url: string, body: Record<string, unknown>) {
    if (!reason.trim()) { push("A reason is required.", "amber"); return; }
    setBusy(true);
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, reason }) }).catch(() => null);
    setBusy(false);
    if (!r?.ok) { push((await r?.json().catch(() => null))?.error ?? "That didn't go through.", "red"); return; }
    push("Recorded.", "emerald"); setOpen(null); setReason(""); load();
  }

  if (error) return <p className="text-[13px] text-amber">{error}</p>;
  if (!queue) return <p className="text-[13px] text-text-secondary">Loading the offline queue…</p>;
  return (
    <div className="mx-auto max-w-5xl" aria-label="Offline queue">
      <ToastViewport />
      <h1 className="text-[20px] font-semibold tracking-tight">Offline queue</h1>
      {!queue.wardIds.length ? (
        <p className="mt-2 text-[13px] text-text-secondary">You aren&apos;t the charge nurse of a ward right now. The queue belongs to the charge nurse on shift.</p>
      ) : (
        <p className="mt-1 text-[13px] text-text-secondary">{queue.conflicts.length} to resolve · {queue.overrides.length} taken over, to confirm in person.</p>
      )}

      {queue.conflicts.length > 0 && (
        <Card className="mt-4">
          <CardLabel>To resolve</CardLabel>
          <ul className="mt-2 space-y-2">
            {queue.conflicts.map((c) => (
              <li key={c.conflictId} data-testid={`conflict-${c.kind}`} className={`rounded-lg border px-3 py-2 text-[13px] ${c.severity === "CRITICAL" ? "border-red-500/50 bg-red-500/[0.05]" : "border-hairline"}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 font-medium">
                    {c.severity === "CRITICAL" ? <ShieldAlert size={14} className="text-red-500" /> : <AlertTriangle size={14} className="text-amber" />}
                    {KIND_TEXT[c.kind] ?? c.kind}
                    {c.patient && <span className="font-normal text-text-secondary">· {c.patient.name} ({c.patient.uhid})</span>}
                  </span>
                  <span className="text-[11.5px] text-text-tertiary">
                    raised {time(c.raisedAt)}{c.severity === "CRITICAL" && <> · respond by {time(c.dueAt)}</>}{c.escalatedAt && <span className="ml-1 text-red-500">· pharmacist told {time(c.escalatedAt)}</span>}
                  </span>
                </div>
                <p className="mt-0.5 text-[12px] text-text-secondary">
                  {c.drug ?? c.command.kind.toLowerCase().replace(/_/g, " ")} · recorded {time(c.command.recordedAt)} on {c.device ?? "a device"}{c.nurse ? ` by ${c.nurse}` : ""}{c.command.refusalReason ? ` · refused: ${c.command.refusalReason.toLowerCase().replace(/_/g, " ")}` : ""}
                </p>
                {open === c.conflictId ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <select aria-label="Resolution" value={resolution} onChange={(e) => setResolution(e.target.value)} className="rounded-md border border-hairline bg-card px-2 py-1 text-[12px]">
                      {RESOLUTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    <input aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" className="min-w-[220px] flex-1 rounded-md border border-hairline bg-card px-2 py-1 text-[12px]" />
                    <button disabled={busy} onClick={() => act(`/api/hospital/offline/conflicts/${c.conflictId}/resolve`, { resolution })} className="rounded-md bg-cyan px-3 py-1 text-[12px] font-medium text-ink disabled:opacity-50">Resolve</button>
                    <button onClick={() => setOpen(null)} className="text-[12px] text-text-secondary">Cancel</button>
                  </div>
                ) : (
                  <button onClick={() => { setOpen(c.conflictId); setReason(""); }} className="mt-2 rounded-md border border-hairline px-2.5 py-1 text-[12px]">Resolve…</button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {queue.overrides.length > 0 && (
        <Card className="mt-4">
          <CardLabel>Taken over from a device</CardLabel>
          <ul className="mt-2 space-y-2">
            {queue.overrides.map((o) => (
              <li key={o.leaseId} className="rounded-lg border border-hairline px-3 py-2 text-[13px]">
                <div className="font-medium">{o.drug ?? "A dose"}{o.patient && <span className="font-normal text-text-secondary"> · {o.patient.name} ({o.patient.uhid})</span>}</div>
                <p className="mt-0.5 text-[12px] text-text-secondary">
                  due {time(o.scheduledAt)} · taken over {time(o.takenOverAt)}{o.takenOverBy ? ` by ${o.takenOverBy}` : ""} from {o.device ?? "a device"}{o.reason ? ` (${o.reason})` : ""} · {o.deviceSynced ? "the device has synced since" : "possibly given offline: check the patient and the nurse"}
                </p>
                {open === o.leaseId ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What you confirmed (required)" className="min-w-[220px] flex-1 rounded-md border border-hairline bg-card px-2 py-1 text-[12px]" />
                    <button disabled={busy} onClick={() => act(`/api/hospital/offline/leases/${o.leaseId}/confirm`, {})} className="rounded-md bg-cyan px-3 py-1 text-[12px] font-medium text-ink disabled:opacity-50">Confirm in person</button>
                    <button onClick={() => setOpen(null)} className="text-[12px] text-text-secondary">Cancel</button>
                  </div>
                ) : (
                  <button onClick={() => { setOpen(o.leaseId); setReason(""); }} className="mt-2 rounded-md border border-hairline px-2.5 py-1 text-[12px]">Confirm…</button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {queue.wardIds.length > 0 && !queue.conflicts.length && !queue.overrides.length && (
        <p className="mt-4 flex items-center gap-1.5 text-[13px] text-success"><CheckCircle2 size={14} /> Nothing waiting.</p>
      )}
    </div>
  );
}
