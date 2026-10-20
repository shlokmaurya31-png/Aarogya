"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CalendarCheck } from "lucide-react";

/**
 * Week 5a — the doctor's directory bookings that carry the patient's record
 * share (docs/DOCTOR_NETWORK_DESIGN.md §7). Each opens the shared record and
 * its visit brief, while the share is live (from a day before the slot to a
 * day after); outside that window the record isn't available.
 */
interface Row { bookingId: string; shareId: string; start: string; status: string; patientName: string; mode: string }

export default function DirectoryBookingsPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => {
    fetch("/api/hospital/directory-bookings").then((r) => (r.ok ? r.json() : { bookings: [] })).then((d) => setRows(d.bookings ?? [])).catch(() => setRows([]));
  }, []);
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center gap-2"><CalendarCheck size={18} className="text-brand" /><h1 className="text-[20px] font-semibold tracking-tight">Bookings with a shared record</h1></div>
      {rows === null ? <p className="text-[13px] text-text-tertiary">Loading…</p> : rows.length === 0 ? <p className="text-[13px] text-text-tertiary">No bookings with a shared record.</p> : (
        <ul className="space-y-2" aria-label="Directory bookings">
          {rows.map((r) => (
            <li key={r.bookingId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline p-3 text-[13px]">
              <span><span className="font-medium">{r.patientName}</span> · {new Date(r.start).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} · {r.mode === "VIDEO" ? "Video" : "In person"} · {r.status.toLowerCase()}</span>
              {r.status !== "CANCELLED" && <Link href={`/hospital-os/doctor/shares/${r.shareId}`} className="rounded-md bg-cyan px-2.5 py-1 text-[12px] font-medium text-ink">Open visit brief</Link>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
