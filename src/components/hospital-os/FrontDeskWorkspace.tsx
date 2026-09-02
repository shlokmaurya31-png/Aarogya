"use client";

import { useEffect, useState } from "react";
import { Search, UserPlus, CalendarPlus, LogIn, Ban, UserX } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";

interface Patient { id: string; fullName: string; uhid: string; sex: string; ageYears: number | null; phone: string | null }
interface Duplicate { patientId: string; uhid: string; fullName: string; confidence: string; score: number }
interface Doctor { staffId: string; displayName: string; displayRole: string; departmentName: string | null }
interface Slot { start: string; end: string; roomLabel: string | null; remainingCapacity: number }
interface Appointment {
  id: string; status: string; type: string; scheduledStart: string; reason: string | null;
  patient: Patient; doctor: { user: { displayName: string } }; encounterId: string | null;
}

const STATUS_TONE: Record<string, "emerald" | "amber" | "red" | "cyan" | "neutral"> = {
  REQUESTED: "neutral", CONFIRMED: "cyan", CHECKED_IN: "emerald", CANCELLED: "red", NO_SHOW: "red", WAITING: "amber",
};

export function FrontDeskWorkspace() {
  const push = useToastStore((s) => s.push);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Patient[] | null>(null);
  const [showRegister, setShowRegister] = useState(false);
  const [regName, setRegName] = useState("");
  const [regSex, setRegSex] = useState("male");
  const [regAge, setRegAge] = useState("");
  const [regPhone, setRegPhone] = useState("");
  const [duplicates, setDuplicates] = useState<Duplicate[] | null>(null);

  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [bookPatientId, setBookPatientId] = useState("");
  const [bookDoctorId, setBookDoctorId] = useState("");
  const [bookDate, setBookDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [bookReason, setBookReason] = useState("");

  const [appointments, setAppointments] = useState<Appointment[] | null>(null);

  function loadToday() {
    fetch(`/api/hospital/appointments?date=${new Date().toISOString().slice(0, 10)}`)
      .then((r) => r.json())
      .then((d) => setAppointments(d.appointments ?? []));
  }
  useEffect(loadToday, []);
  useEffect(() => {
    fetch("/api/hospital/doctors").then((r) => r.json()).then((d) => setDoctors(d.doctors ?? []));
  }, []);

  async function search() {
    if (!query.trim()) { setResults(null); return; }
    const res = await fetch(`/api/hospital/patients?query=${encodeURIComponent(query)}`);
    const data = await res.json();
    setResults(data.patients ?? []);
  }

  async function checkDuplicates() {
    if (!regName.trim()) return;
    const res = await fetch("/api/hospital/patients/duplicates", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: regName, sex: regSex, phone: regPhone || undefined }),
    });
    const data = await res.json();
    setDuplicates((data.candidates ?? []).filter((c: Duplicate) => c.confidence !== "NO_MATCH"));
  }

  async function registerPatient() {
    if (!regName.trim()) return;
    const res = await fetch("/api/hospital/patients", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: regName, sex: regSex, ageYears: regAge ? Number(regAge) : undefined, phone: regPhone || undefined }),
    });
    const data = await res.json();
    if (!res.ok) { push(data.error ?? "Registration failed.", "red"); return; }
    push(`Registered ${data.patient.fullName} (${data.patient.uhid}).`, "emerald");
    setShowRegister(false); setRegName(""); setRegAge(""); setRegPhone(""); setDuplicates(null);
    setBookPatientId(data.patient.id);
  }

  function loadSlots() {
    if (!bookDoctorId || !bookDate) return;
    fetch(`/api/hospital/doctors/${bookDoctorId}/slots?date=${bookDate}`).then((r) => r.json()).then((d) => setSlots(d.slots ?? []));
  }
  useEffect(() => {
    if (!bookDoctorId || !bookDate) return;
    fetch(`/api/hospital/doctors/${bookDoctorId}/slots?date=${bookDate}`).then((r) => r.json()).then((d) => setSlots(d.slots ?? []));
  }, [bookDoctorId, bookDate]);

  async function bookSlot(slot: Slot) {
    if (!bookPatientId || !bookDoctorId) { push("Select a patient and doctor first.", "red"); return; }
    const res = await fetch("/api/hospital/appointments", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ doctorStaffId: bookDoctorId, patientId: bookPatientId, scheduledStart: slot.start, scheduledEnd: slot.end, reason: bookReason || undefined }),
    });
    const data = await res.json();
    if (!res.ok) { push(data.error ?? "Booking failed.", "red"); return; }
    push("Appointment booked.", "emerald");
    setBookReason("");
    loadSlots(); loadToday();
  }

  async function checkIn(appointmentId: string) {
    const res = await fetch(`/api/hospital/appointments/${appointmentId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "checkIn" }),
    });
    const data = await res.json();
    if (!res.ok) { push(data.error ?? "Check-in failed.", "red"); return; }
    push("Patient checked in.", "emerald");
    loadToday();
  }

  async function cancelAppt(appointmentId: string) {
    const reason = window.prompt("Cancellation reason?");
    if (!reason) return;
    const res = await fetch(`/api/hospital/appointments/${appointmentId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel", reason }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push("Appointment cancelled.", "amber");
    loadToday();
  }

  async function noShow(appointmentId: string) {
    const res = await fetch(`/api/hospital/appointments/${appointmentId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "noShow" }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push("Marked no-show.", "amber");
    loadToday();
  }

  return (
    <div className="mx-auto max-w-6xl">
      <ToastViewport />
      <h1 className="text-[20px] font-semibold tracking-tight">Front Desk</h1>
      <p className="mt-1 text-[13px] text-text-secondary">Registration, appointments and check-in.</p>

      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card className="rounded-[20px]">
            <div className="flex items-center gap-2"><Search size={14} className="text-cyan" /><CardLabel>Find patient</CardLabel></div>
            <div className="mt-2 flex gap-2">
              <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} placeholder="UHID, name or phone" className="flex-1 rounded-md border border-hairline bg-black/[0.02] px-3 py-2 text-[13px] outline-none focus:border-cyan/40" />
              <button onClick={search} className="rounded-md border border-hairline-strong px-3 py-2 text-[12.5px] font-medium hover:border-cyan/40">Search</button>
              <button onClick={() => setShowRegister((v) => !v)} className="flex items-center gap-1.5 rounded-md bg-cyan px-3 py-2 text-[12.5px] font-medium text-ink hover:brightness-110"><UserPlus size={13} /> New patient</button>
            </div>

            {results && (
              <div className="mt-3 space-y-1.5">
                {results.map((p) => (
                  <button key={p.id} onClick={() => setBookPatientId(p.id)} className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-[12.5px] ${bookPatientId === p.id ? "border-cyan/50 bg-cyan/5" : "border-hairline hover:border-cyan/30"}`}>
                    <span>{p.fullName} <span className="text-text-tertiary">· {p.uhid} · {p.ageYears ?? "?"}{p.sex[0]?.toUpperCase()}</span></span>
                    {bookPatientId === p.id && <StatusPill label="Selected for booking" tone="cyan" className="rounded-md" />}
                  </button>
                ))}
                {results.length === 0 && <p className="text-[12.5px] text-text-tertiary">No matches.</p>}
              </div>
            )}

            {showRegister && (
              <div className="mt-3 space-y-2.5 border-t border-hairline pt-3">
                <div className="grid grid-cols-2 gap-2">
                  <input value={regName} onChange={(e) => setRegName(e.target.value)} onBlur={checkDuplicates} placeholder="Full name" className="rounded-md border border-hairline bg-black/[0.02] px-3 py-2 text-[13px] outline-none focus:border-cyan/40" />
                  <select value={regSex} onChange={(e) => setRegSex(e.target.value)} className="rounded-md border border-hairline bg-black/[0.02] px-3 py-2 text-[13px] outline-none focus:border-cyan/40">
                    <option value="male">Male</option><option value="female">Female</option><option value="other">Other</option>
                  </select>
                  <input value={regAge} onChange={(e) => setRegAge(e.target.value)} placeholder="Age (years)" className="rounded-md border border-hairline bg-black/[0.02] px-3 py-2 text-[13px] outline-none focus:border-cyan/40" />
                  <input value={regPhone} onChange={(e) => setRegPhone(e.target.value)} onBlur={checkDuplicates} placeholder="Phone" className="rounded-md border border-hairline bg-black/[0.02] px-3 py-2 text-[13px] outline-none focus:border-cyan/40" />
                </div>
                {duplicates && duplicates.length > 0 && (
                  <div className="rounded-md border border-amber/30 bg-amber/[0.06] p-2.5">
                    <p className="text-[11.5px] font-medium text-amber">Possible existing patient — check before creating a duplicate:</p>
                    {duplicates.map((d) => (
                      <p key={d.patientId} className="mt-1 text-[11.5px] text-text-secondary">{d.fullName} · {d.uhid} · {d.confidence.replaceAll("_", " ").toLowerCase()}</p>
                    ))}
                  </div>
                )}
                <button onClick={registerPatient} className="rounded-md bg-emerald px-4 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110">Register patient</button>
              </div>
            )}
          </Card>

          <Card className="rounded-[20px]">
            <div className="flex items-center gap-2"><CalendarPlus size={14} className="text-cyan" /><CardLabel>Book appointment</CardLabel></div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <select value={bookDoctorId} onChange={(e) => setBookDoctorId(e.target.value)} className="rounded-md border border-hairline bg-black/[0.02] px-3 py-2 text-[13px] outline-none focus:border-cyan/40">
                <option value="">Select doctor...</option>
                {doctors.map((d) => <option key={d.staffId} value={d.staffId}>{d.displayName} — {d.displayRole}</option>)}
              </select>
              <input type="date" value={bookDate} onChange={(e) => setBookDate(e.target.value)} className="rounded-md border border-hairline bg-black/[0.02] px-3 py-2 text-[13px] outline-none focus:border-cyan/40" />
              <input value={bookReason} onChange={(e) => setBookReason(e.target.value)} placeholder="Reason for visit" className="col-span-2 rounded-md border border-hairline bg-black/[0.02] px-3 py-2 text-[13px] outline-none focus:border-cyan/40" />
            </div>
            {bookPatientId && <p className="mt-2 text-[11.5px] text-text-tertiary">Booking for selected patient above.</p>}
            {slots && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {slots.map((s) => (
                  <button key={s.start} onClick={() => bookSlot(s)} className="rounded-md border border-hairline-strong px-2.5 py-1.5 text-[11.5px] hover:border-cyan/40 hover:text-cyan">
                    {new Date(s.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </button>
                ))}
                {slots.length === 0 && <p className="text-[12px] text-text-tertiary">No available slots — no clinic session configured, or fully booked.</p>}
              </div>
            )}
          </Card>
        </div>

        <div>
          <Card className="rounded-[20px]">
            <CardLabel>Today&apos;s appointments</CardLabel>
            <div className="mt-2.5 space-y-2">
              {appointments?.map((a) => (
                <div key={a.id} className="rounded-lg border border-hairline p-2.5">
                  <div className="flex items-center justify-between">
                    <p className="text-[12.5px] font-medium">{a.patient.fullName}</p>
                    <StatusPill label={a.status.replaceAll("_", " ")} tone={STATUS_TONE[a.status] ?? "neutral"} className="rounded-md" />
                  </div>
                  <p className="text-[11px] text-text-tertiary">{a.doctor.user.displayName} · {new Date(a.scheduledStart).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
                  {["REQUESTED", "CONFIRMED"].includes(a.status) && (
                    <div className="mt-2 flex gap-1.5">
                      <button onClick={() => checkIn(a.id)} className="flex items-center gap-1 rounded-md bg-emerald px-2 py-1 text-[10.5px] font-medium text-white hover:brightness-110"><LogIn size={10} /> Check in</button>
                      <button onClick={() => noShow(a.id)} className="flex items-center gap-1 rounded-md border border-hairline-strong px-2 py-1 text-[10.5px] hover:border-amber/40 hover:text-amber"><UserX size={10} /> No-show</button>
                      <button onClick={() => cancelAppt(a.id)} className="flex items-center gap-1 rounded-md border border-hairline-strong px-2 py-1 text-[10.5px] hover:border-red/40 hover:text-red"><Ban size={10} /> Cancel</button>
                    </div>
                  )}
                </div>
              ))}
              {appointments?.length === 0 && <p className="text-[12.5px] text-text-tertiary">No appointments today.</p>}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
