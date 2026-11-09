"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";

/**
 * Flagship 6 — the desk's Scan and Share check-ins: each counter's QR, and
 * the day's tokens from patients who scanned it and shared their ABHA
 * profile. A known record (by its verified ABHA number) is already in the
 * registration queue; for the others the desk registers from the shared
 * profile, or queues them for an existing UHID. The patient fills in no form.
 */
interface Row { id: string; token: string; status: string; counter: string; name: string; sex: string; yearOfBirth: number | null; phoneLast4: string | null; abhaAddress: string; abhaLast4: string | null; uhid: string | null; at: string }
interface Counter { id: string; code: string; label: string; url: string; svg: string }

export function ScanShareDesk() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [counters, setCounters] = useState<Counter[]>([]);
  const [showQr, setShowQr] = useState(false);
  const [uhid, setUhid] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    fetch("/api/hospital/scan-share/checkins").then((r) => (r.ok ? r.json() : { checkIns: [] })).then((d) => setRows(d.checkIns ?? [])).catch(() => setRows([]));
  }, []);
  useEffect(() => {
    load();
    fetch("/api/hospital/scan-share/counters").then((r) => (r.ok ? r.json() : { counters: [] })).then((d) => setCounters(d.counters ?? [])).catch(() => setCounters([]));
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);
  async function queue(id: string) {
    const r = await fetch(`/api/hospital/scan-share/checkins/${id}/queue`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(uhid[id]?.trim() ? { uhid: uhid[id].trim() } : {}) }).catch(() => null);
    const d = await r?.json().catch(() => null);
    setMsg(r?.ok ? (d.registered ? "Registered from the shared profile and queued." : "Queued for the existing record.") : d?.error ?? "That didn't go through.");
    load();
  }
  if (!rows) return null;
  return (
    <Card aria-label="Scan and Share">
      <div className="flex items-center justify-between">
        <CardLabel>Scan and Share ({rows.length} today)</CardLabel>
        {counters.length > 0 && <button onClick={() => setShowQr(!showQr)} className="rounded-md border border-hairline px-2.5 py-1 text-[12px]">{showQr ? "Hide QR" : "Show the counter QR"}</button>}
      </div>
      {showQr && (
        <div className="mt-2 flex flex-wrap gap-4">
          {counters.map((c) => (
            <figure key={c.id} className="text-center text-[12px]">
              <div className="h-48 w-48 bg-white p-1" dangerouslySetInnerHTML={{ __html: c.svg }} />
              <figcaption className="mt-1">{c.label}</figcaption>
            </figure>
          ))}
        </div>
      )}
      {msg && <p className="mt-2 text-[12px] text-text-secondary">{msg}</p>}
      <ul className="mt-2 space-y-1.5">
        {rows.map((r) => (
          <li key={r.id} data-testid={`scan-${r.token}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-hairline px-3 py-2 text-[13px]">
            <span><span className="font-semibold">{r.token}</span> · {r.name} · {r.sex}{r.yearOfBirth ? ` · born ${r.yearOfBirth}` : ""} · ABHA {r.abhaAddress}{r.uhid ? ` · ${r.uhid}` : ""}</span>
            {r.status === "WAITING" ? (
              <span className="flex items-center gap-1.5">
                <input aria-label={`Existing UHID for ${r.token}`} value={uhid[r.id] ?? ""} onChange={(e) => setUhid({ ...uhid, [r.id]: e.target.value })} placeholder="Existing UHID (optional)" className="w-44 rounded-md border border-hairline bg-card px-2 py-1 text-[12px]" />
                <button onClick={() => queue(r.id)} className="rounded-md bg-cyan px-2.5 py-1 text-[12px] font-medium text-ink">{uhid[r.id]?.trim() ? "Queue" : "Register and queue"}</button>
              </span>
            ) : <StatusPill tone={r.status === "QUEUED" ? "success" : "neutral"} label={r.status === "QUEUED" ? "In the queue" : r.status.toLowerCase()} />}
          </li>
        ))}
        {!rows.length && <li className="text-[12px] text-text-tertiary">No one has scanned in yet today.</li>}
      </ul>
    </Card>
  );
}
