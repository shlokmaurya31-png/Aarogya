"use client";

import { useState } from "react";
import { Card, SectionTitle, Empty, Unavailable, usePatientData, formatDate } from "@/components/patient-portal/ui";

interface Profile {
  fullName: string; preferredName: string | null; sex: string; dob: string | null;
  phone: string | null; address: string | null; language: string | null;
  communicationPreference: string | null; bloodGroup: string | null; uhidMasked: string;
  emergencyContacts: { name: string; relation: string; phone: string }[];
}

export default function ProfilePage() {
  const { state, reload } = usePatientData<Profile>("/api/patient/profile");
  const [msg, setMsg] = useState<string | null>(null);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setMsg(null);
    const fd = new FormData(e.currentTarget);
    const body = {
      preferredName: String(fd.get("preferredName") ?? ""),
      phone: String(fd.get("phone") ?? ""),
      address: String(fd.get("address") ?? ""),
      communicationPreference: String(fd.get("communicationPreference") ?? "SMS"),
    };
    const r = await fetch("/api/patient/profile", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.ok) { setMsg("Saved."); reload(); } else { const b = await r.json().catch(() => ({})); setMsg(b.error ?? "Could not save."); }
  }

  if (state.status === "loading") return <Empty>Loading…</Empty>;
  if (state.status === "error") return <Unavailable label="Your profile" />;
  const p = state.data;

  return (
    <div className="space-y-5">
      <h1 className="text-[18px] font-semibold">Profile</h1>
      <Card>
        <SectionTitle>Your details</SectionTitle>
        <dl className="grid grid-cols-2 gap-y-2 text-[13px]">
          <dt className="text-text-secondary">Name</dt><dd>{p.fullName}</dd>
          <dt className="text-text-secondary">Sex</dt><dd>{p.sex}</dd>
          <dt className="text-text-secondary">Date of birth</dt><dd>{formatDate(p.dob)}</dd>
          <dt className="text-text-secondary">Blood group</dt><dd>{p.bloodGroup ?? "—"}</dd>
          <dt className="text-text-secondary">Patient ID</dt><dd>{p.uhidMasked}</dd>
        </dl>
      </Card>
      <Card>
        <SectionTitle>Contact & preferences</SectionTitle>
        <form onSubmit={save} className="space-y-3">
          <input name="preferredName" defaultValue={p.preferredName ?? ""} placeholder="Preferred name" className="w-full rounded-md border border-hairline bg-surface px-3 py-2 text-[13px]" />
          <input name="phone" defaultValue={p.phone ?? ""} placeholder="Phone" className="w-full rounded-md border border-hairline bg-surface px-3 py-2 text-[13px]" />
          <input name="address" defaultValue={p.address ?? ""} placeholder="Address" className="w-full rounded-md border border-hairline bg-surface px-3 py-2 text-[13px]" />
          <select name="communicationPreference" defaultValue={p.communicationPreference ?? "SMS"} className="w-full rounded-md border border-hairline bg-surface px-3 py-2 text-[13px]">
            <option value="SMS">Notify me by SMS</option>
            <option value="EMAIL">Notify me by email</option>
            <option value="CALL">Notify me by call</option>
            <option value="NONE">No notifications</option>
          </select>
          {msg && <p className="text-[12px] text-text-secondary">{msg}</p>}
          <button type="submit" className="rounded-md bg-cyan px-4 py-2 text-[13px] font-medium text-white">Save</button>
        </form>
      </Card>
      <Card>
        <SectionTitle>Emergency contacts</SectionTitle>
        {p.emergencyContacts.length ? (
          <ul className="space-y-1">{p.emergencyContacts.map((c, i) => <li key={i} className="text-[13px]">{c.name} ({c.relation}) · {c.phone}</li>)}</ul>
        ) : <Empty>None on record.</Empty>}
      </Card>
    </div>
  );
}
