"use client";

import { useEffect, useState } from "react";
import { Search, Stethoscope, Video, MapPin, BadgeCheck } from "lucide-react";
import { Card, SectionTitle, Empty } from "@/components/patient-portal/ui";
import { DEFAULT_SHARE_CHOICE, ShareChoices, choiceBody, type ShareChoiceValue } from "@/components/patient-portal/ShareChoices";

/**
 * Week 5a — find a doctor (docs/DOCTOR_NETWORK_DESIGN.md §6, §7): search by
 * symptom or specialty, language, mode, fee, distance and next slot; book a
 * slot the engine offers live, optionally sharing the record with that doctor
 * for the visit (the 4c choices, pre-selected). Only verified doctors appear.
 * The symptom map is pending the clinical advisor's sign-off, and a general
 * physician is always offered.
 */
interface Loc { id: string; kind: string; facilityName: string; city: string | null; modes: string[]; feeMinor: number | null; distanceKm: number | null; nextSlotAt: string | null }
interface Entry { doctorId: string; name: string; council: string; registrationNumber: string; registeredSince: number | null; specialties: { code: string; label: string; primary: boolean }[]; languages: string[]; locations: Loc[] }
interface Symptom { code: string; label: string }
interface Slot { start: string; end: string }

const rupees = (m: number | null) => (m === null ? "Fee at the desk" : `₹${(m / 100).toLocaleString("en-IN")}`);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "No free slot in the next two weeks");

/**
 * The India calendar day (YYYY-MM-DD) of an instant: the day the slots API reads.
 * Not the ISO string's own date, which is the UTC day and, from midnight to
 * 05:30 India time, yesterday (every slot of it already past).
 */
const indiaDay = (at: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

function Booker({ doctor, loc, onBooked }: { doctor: Entry; loc: Loc; onBooked: (msg: string) => void }) {
  const [day, setDay] = useState(() => indiaDay(loc.nextSlotAt ? new Date(loc.nextSlotAt) : new Date()));
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [start, setStart] = useState("");
  const [mode, setMode] = useState(loc.modes[0] ?? "IN_PERSON");
  const [share, setShare] = useState(true);
  const [choice, setChoice] = useState<ShareChoiceValue>({ categories: DEFAULT_SHARE_CHOICE, sensitiveCategories: [], from: "", to: "" });
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`/api/doctors/locations/${loc.id}/slots?date=${day}`).then((r) => (r.ok ? r.json() : { slots: [] })).then((d) => alive && setSlots(d.slots ?? [])).catch(() => alive && setSlots([]));
    return () => { alive = false; };
  }, [loc.id, day]);
  async function book() {
    setError(null);
    const r = await fetch(`/api/doctors/locations/${loc.id}/book`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start, mode, reason: reason || undefined, share: share ? choiceBody(choice) : null }),
    }).catch(() => null);
    const body = await r?.json().catch(() => null);
    if (r?.ok) onBooked(`Booked with ${doctor.name} on ${when(body.start)}${body.shareId ? ", and your record is shared for this visit" : ""}.`);
    else setError(body?.error ?? "That didn't go through. Try another time.");
  }
  return (
    <div className="mt-3 space-y-3 rounded-xl border border-hairline p-3" aria-label="Book">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <input type="date" aria-label="Day" value={day} onChange={(e) => { setDay(e.target.value); setStart(""); }} className="rounded-md border border-hairline bg-transparent px-2 py-1" />
        {loc.modes.length > 1 && (
          <select aria-label="Visit type" value={mode} onChange={(e) => setMode(e.target.value)} className="rounded-md border border-hairline bg-transparent px-2 py-1">
            {loc.modes.map((m) => <option key={m} value={m}>{m === "VIDEO" ? "Video" : "In person"}</option>)}
          </select>
        )}
      </div>
      {slots === null ? <Empty>Loading times…</Empty> : slots.length === 0 ? <Empty>No free times that day.</Empty> : (
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Times">
          {slots.slice(0, 24).map((s) => (
            <button key={s.start} role="radio" aria-checked={start === s.start} onClick={() => setStart(s.start)} className={`rounded-md border px-2 py-1 text-[12px] ${start === s.start ? "border-brand bg-accent/10" : "border-hairline"}`}>
              {new Date(s.start).toLocaleTimeString(undefined, { timeStyle: "short" })}
            </button>
          ))}
        </div>
      )}
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for the visit (optional)" className="w-full rounded-md border border-hairline bg-transparent px-2 py-1.5 text-[12.5px]" />
      <label className="flex items-center gap-2 text-[12.5px]">
        <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} />
        Share my record with {doctor.name} for this visit (from a day before to a day after)
      </label>
      {share && <ShareChoices value={choice} onChange={setChoice} />}
      {mode === "VIDEO" && <p className="text-[11.5px] text-text-tertiary">Video visits are not recorded.</p>}
      {error && <p className="text-[12px] text-amber">{error}</p>}
      <button onClick={book} disabled={!start || (share && !choice.categories.length)} className="rounded-md bg-cyan px-3 py-1.5 text-[12.5px] font-medium text-ink disabled:opacity-50">Book</button>
    </div>
  );
}

export default function FindDoctorPage() {
  const [symptoms, setSymptoms] = useState<Symptom[]>([]);
  const [pending, setPending] = useState(true);
  const [q, setQ] = useState({ symptom: "", language: "", mode: "", maxFee: "", slotWithinDays: "" });
  const [results, setResults] = useState<Entry[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/doctors/symptoms").then((r) => r.json()).then((d) => { setSymptoms(d.symptoms ?? []); setPending(d.pendingClinicalAdvisor !== false); }).catch(() => undefined);
  }, []);
  async function search() {
    const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v));
    const r = await fetch(`/api/doctors/search?${p}`).catch(() => null);
    const d = r?.ok ? await r.json() : null;
    setResults(d?.results ?? []);
    setNote(d?.symptom ? "A general physician can also help with any symptom." : null);
  }
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex items-center gap-2"><Stethoscope size={18} className="text-brand" /><h1 className="text-[20px] font-semibold tracking-tight">Find a doctor</h1></div>
      <Card>
        <div className="grid gap-2 sm:grid-cols-2">
          <select aria-label="Symptom" value={q.symptom} onChange={(e) => setQ({ ...q, symptom: e.target.value })} className="rounded-md border border-hairline bg-transparent px-2 py-1.5 text-[13px]">
            <option value="">What&apos;s troubling you?</option>
            {symptoms.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
          </select>
          <select aria-label="Language" value={q.language} onChange={(e) => setQ({ ...q, language: e.target.value })} className="rounded-md border border-hairline bg-transparent px-2 py-1.5 text-[13px]">
            <option value="">Any language</option>
            {[["en", "English"], ["hi", "Hindi"], ["mr", "Marathi"], ["ta", "Tamil"], ["te", "Telugu"], ["bn", "Bengali"], ["kn", "Kannada"], ["gu", "Gujarati"]].map(([c, l]) => <option key={c} value={c}>{l}</option>)}
          </select>
          <select aria-label="Visit type" value={q.mode} onChange={(e) => setQ({ ...q, mode: e.target.value })} className="rounded-md border border-hairline bg-transparent px-2 py-1.5 text-[13px]">
            <option value="">In person or video</option><option value="IN_PERSON">In person</option><option value="VIDEO">Video</option>
          </select>
          <input aria-label="Maximum fee" inputMode="numeric" value={q.maxFee} onChange={(e) => setQ({ ...q, maxFee: e.target.value })} placeholder="Maximum fee (₹)" className="rounded-md border border-hairline bg-transparent px-2 py-1.5 text-[13px]" />
        </div>
        {pending && <p className="mt-2 text-[11px] text-text-tertiary">The symptom list is waiting for our clinical advisor&apos;s review. It suggests a kind of doctor; it is not a diagnosis.</p>}
        <button onClick={search} className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-cyan px-3 py-1.5 text-[12.5px] font-medium text-ink"><Search size={13} /> Search</button>
      </Card>
      {done && <p className="rounded-xl border border-emerald/40 bg-emerald/5 px-3 py-2 text-[13px]" role="status">{done}</p>}
      {results !== null && (
        <Card>
          <SectionTitle>{results.length ? `${results.length} doctor${results.length > 1 ? "s" : ""}` : "No doctors found"}</SectionTitle>
          {note && <p className="mb-2 text-[12px] text-text-secondary">{note}</p>}
          <ul className="space-y-4" aria-label="Doctors">
            {results.map((d) => (
              <li key={d.doctorId} className="border-b border-hairline pb-3 last:border-0">
                <p className="flex items-center gap-1.5 text-[14px] font-semibold">{d.name}<BadgeCheck size={14} className="text-brand" aria-label="Verified registration" /></p>
                <p className="text-[12px] text-text-secondary">{d.specialties.map((s) => s.label).join(" · ")}</p>
                <p className="text-[11.5px] text-text-tertiary">{d.council} · Reg. {d.registrationNumber}{d.registeredSince ? ` · Registered since ${d.registeredSince}` : ""}</p>
                {d.locations.map((l) => (
                  <div key={l.id} className="mt-2 text-[12.5px]">
                    <p className="flex flex-wrap items-center gap-x-2">
                      <MapPin size={12} /> {l.facilityName}{l.city ? `, ${l.city}` : ""}{l.distanceKm !== null ? ` · ${l.distanceKm} km` : ""}
                      <span>· {rupees(l.feeMinor)}</span>
                      {l.modes.includes("VIDEO") && <span className="inline-flex items-center gap-1"><Video size={12} /> Video</span>}
                      <span className="text-text-tertiary">· Next: {when(l.nextSlotAt)}</span>
                    </p>
                    {open === l.id ? <Booker doctor={d} loc={l} onBooked={(m) => { setDone(m); setOpen(null); }} /> : (
                      <button onClick={() => setOpen(l.id)} className="mt-1 rounded-md border border-hairline px-2.5 py-1 text-[12px]">Book here</button>
                    )}
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
