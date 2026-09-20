"use client";

import { useState } from "react";
import { Card, SectionTitle, Empty, Unavailable, usePatientData, formatDateTime, StatusPill } from "@/components/patient-portal/ui";

interface Appt { id: string; doctorName: string; department: string | null; scheduledStart: string; statusLabel: string; typeLabel: string; reason: string | null; canCancel: boolean; }
interface Doctor { staffId: string; name: string; role: string; department: string | null; slotMinutes: number; }

export default function AppointmentsPage() {
  const { state, reload } = usePatientData<{ upcoming: Appt[]; past: Appt[] }>("/api/patient/appointments");
  const docs = usePatientData<{ doctors: Doctor[] }>("/api/patient/appointments/doctors");
  const [booking, setBooking] = useState(false);
  const [doctorStaffId, setDoctorStaffId] = useState("");
  const [scheduledStart, setScheduledStart] = useState("");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  async function book(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const r = await fetch("/api/patient/appointments", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ doctorStaffId, scheduledStart: new Date(scheduledStart).toISOString(), reason: reason || undefined }),
    });
    if (r.ok) { setBooking(false); setDoctorStaffId(""); setScheduledStart(""); setReason(""); reload(); }
    else { const b = await r.json().catch(() => ({})); setMsg(b.error ?? "Could not book that time."); }
  }

  async function cancel(id: string) {
    const r = await fetch(`/api/patient/appointments/${id}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "Cancelled by patient" }) });
    if (r.ok) reload();
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-[18px] font-semibold">Appointments</h1>
        <button onClick={() => setBooking((v) => !v)} className="rounded-md bg-cyan px-3 py-1.5 text-[12px] font-medium text-white">{booking ? "Close" : "Book appointment"}</button>
      </div>

      {booking && (
        <Card>
          <SectionTitle>Request an appointment</SectionTitle>
          <form onSubmit={book} className="space-y-3">
            <select required value={doctorStaffId} onChange={(e) => setDoctorStaffId(e.target.value)} className="w-full rounded-md border border-hairline bg-surface px-3 py-2 text-[13px]">
              <option value="">Select a doctor…</option>
              {docs.state.status === "ok" && docs.state.data.doctors.map((d) => (
                <option key={d.staffId} value={d.staffId}>{d.name} — {d.role}{d.department ? ` (${d.department})` : ""}</option>
              ))}
            </select>
            <input required type="datetime-local" value={scheduledStart} onChange={(e) => setScheduledStart(e.target.value)} className="w-full rounded-md border border-hairline bg-surface px-3 py-2 text-[13px]" />
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" className="w-full rounded-md border border-hairline bg-surface px-3 py-2 text-[13px]" />
            {msg && <p className="text-[12px] text-red">{msg}</p>}
            <button type="submit" className="rounded-md bg-cyan px-4 py-2 text-[13px] font-medium text-white">Request</button>
          </form>
        </Card>
      )}

      <Card>
        <SectionTitle>Upcoming</SectionTitle>
        {state.status === "loading" ? <Empty>Loading…</Empty> : state.status === "error" ? <Unavailable label="Appointments" /> : state.data.upcoming.length === 0 ? <Empty>No upcoming appointments.</Empty> : (
          <ul className="space-y-3">
            {state.data.upcoming.map((a) => (
              <li key={a.id} className="flex items-center justify-between border-b border-hairline pb-3 last:border-0 last:pb-0">
                <div>
                  <div className="text-[14px] font-medium">{a.doctorName}</div>
                  <div className="text-[12px] text-text-secondary">{a.department ?? a.typeLabel} · {formatDateTime(a.scheduledStart)}</div>
                  {a.reason && <div className="text-[12px] text-text-tertiary">{a.reason}</div>}
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill label={a.statusLabel} tone="info" />
                  {a.canCancel && <button onClick={() => cancel(a.id)} className="rounded-md border border-hairline px-2 py-1 text-[11px] text-text-secondary hover:border-red/30 hover:text-red">Cancel</button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <SectionTitle>Past</SectionTitle>
        {state.status === "ok" && state.data.past.length > 0 ? (
          <ul className="space-y-2">
            {state.data.past.slice(0, 20).map((a) => (
              <li key={a.id} className="flex items-center justify-between text-[13px]">
                <span>{a.doctorName} · {formatDateTime(a.scheduledStart)}</span>
                <StatusPill label={a.statusLabel} />
              </li>
            ))}
          </ul>
        ) : <Empty>No past appointments.</Empty>}
      </Card>
    </div>
  );
}
