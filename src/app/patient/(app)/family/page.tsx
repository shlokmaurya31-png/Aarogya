"use client";

import { useState } from "react";
import { Card, SectionTitle, Empty, Unavailable, usePatientData, formatDate, StatusPill } from "@/components/patient-portal/ui";

const SCOPES = ["APPOINTMENTS", "RECORDS", "REPORTS", "PRESCRIPTIONS", "MEDICATIONS", "BILLING", "INSURANCE", "CONSENT"];
const RELATIONSHIPS = ["PARENT", "CHILD", "SPOUSE", "GUARDIAN", "CAREGIVER", "OTHER"];

interface Grant { id: string; delegateName: string | null; invitedContact: string | null; relationship: string; scopes: string[]; status: string; expiresAt: string | null; }

export default function FamilyPage() {
  const { state, reload } = usePatientData<{ granted: Grant[] }>("/api/patient/family");
  const [relationship, setRelationship] = useState("CAREGIVER");
  const [invitedContact, setInvitedContact] = useState("");
  const [invitedName, setInvitedName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["APPOINTMENTS"]);
  const [token, setToken] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  function toggleScope(s: string) { setScopes((cur) => cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]); }

  async function invite(e: React.FormEvent) {
    e.preventDefault(); setMsg(null); setToken(null);
    const r = await fetch("/api/patient/family", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ relationship, invitedContact, invitedName: invitedName || undefined, scopes }) });
    const b = await r.json().catch(() => ({}));
    if (r.ok) { setToken(b.inviteToken); setInvitedContact(""); setInvitedName(""); reload(); }
    else setMsg(b.error ?? "Could not create invitation.");
  }

  async function revoke(id: string) {
    const r = await fetch(`/api/patient/family/${id}/revoke`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    if (r.ok) reload();
  }

  return (
    <div className="space-y-5">
      <h1 className="text-[18px] font-semibold">Family & caregiver access</h1>
      <p className="text-[13px] text-text-secondary">Invite someone you trust to view parts of your record. They can only see what you choose, and you can revoke access any time.</p>

      <Card>
        <SectionTitle>Invite someone</SectionTitle>
        <form onSubmit={invite} className="space-y-3">
          <div className="flex gap-2">
            <select value={relationship} onChange={(e) => setRelationship(e.target.value)} className="rounded-md border border-hairline bg-surface px-3 py-2 text-[13px]">
              {RELATIONSHIPS.map((r) => <option key={r} value={r}>{r.charAt(0) + r.slice(1).toLowerCase()}</option>)}
            </select>
            <input required value={invitedContact} onChange={(e) => setInvitedContact(e.target.value)} placeholder="Their email or phone" className="flex-1 rounded-md border border-hairline bg-surface px-3 py-2 text-[13px]" />
          </div>
          <input value={invitedName} onChange={(e) => setInvitedName(e.target.value)} placeholder="Their name (optional)" className="w-full rounded-md border border-hairline bg-surface px-3 py-2 text-[13px]" />
          <div className="flex flex-wrap gap-2">
            {SCOPES.map((s) => (
              <button type="button" key={s} onClick={() => toggleScope(s)} className={`rounded-full border px-2.5 py-1 text-[11px] ${scopes.includes(s) ? "border-cyan/40 bg-cyan/10 text-cyan" : "border-hairline text-text-secondary"}`}>
                {s.charAt(0) + s.slice(1).toLowerCase()}
              </button>
            ))}
          </div>
          {msg && <p className="text-[12px] text-red">{msg}</p>}
          <button type="submit" className="rounded-md bg-cyan px-4 py-2 text-[13px] font-medium text-white">Create invitation</button>
        </form>
        {token && (
          <div className="mt-3 rounded-lg border border-cyan/30 bg-cyan/5 p-3 text-[12px]">
            <p className="font-medium text-cyan">Share this one-time code with them securely:</p>
            <code className="mt-1 block break-all rounded bg-surface px-2 py-1">{token}</code>
            <p className="mt-1 text-text-tertiary">You will not be able to see this code again.</p>
          </div>
        )}
      </Card>

      <Card>
        <SectionTitle>People with access</SectionTitle>
        {state.status === "loading" ? <Empty>Loading…</Empty> : state.status === "error" ? <Unavailable label="Family access" /> : state.data.granted.length === 0 ? (
          <Empty>You have not shared your record with anyone.</Empty>
        ) : (
          <ul className="space-y-3">
            {state.data.granted.map((g) => (
              <li key={g.id} className="flex items-center justify-between border-b border-hairline pb-3 last:border-0 last:pb-0">
                <div>
                  <div className="text-[14px] font-medium">{g.delegateName ?? g.invitedContact ?? "Invited"} <span className="text-text-tertiary">({g.relationship.toLowerCase()})</span></div>
                  <div className="text-[12px] text-text-secondary">{g.scopes.map((s) => s.toLowerCase()).join(", ")}{g.expiresAt ? ` · until ${formatDate(g.expiresAt)}` : ""}</div>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill label={g.status === "ACTIVE" ? "Active" : g.status === "INVITED" ? "Invited" : g.status.toLowerCase()} tone={g.status === "ACTIVE" ? "good" : "neutral"} />
                  {["ACTIVE", "INVITED"].includes(g.status) && <button onClick={() => revoke(g.id)} className="rounded-md border border-hairline px-2 py-1 text-[11px] text-text-secondary hover:border-red/30 hover:text-red">Revoke</button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
