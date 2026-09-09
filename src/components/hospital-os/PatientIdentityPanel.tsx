"use client";

import { useEffect, useState, useCallback } from "react";
import { Fingerprint, Plus, AlertOctagon } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";

interface Identifier { id: string; type: string; value: string; issuer: string | null; status: string }
interface EmergencyContact { id: string; name: string; relation: string; phone: string; priority: number }
interface PatientIdentity {
  id: string;
  deceasedAt: string | null;
  mergedIntoId: string | null;
  identifiers: Identifier[];
  emergencyContacts: EmergencyContact[];
}

const IDENTIFIER_TYPES = ["ABHA", "MRN", "EXTERNAL_MRN", "INSURANCE_MEMBER_ID", "LEGACY", "OTHER"];

/**
 * Compact identity panel (Phase 6.8 EMPI) — identifiers (ABHA/MRN/insurance),
 * guardian/emergency contacts, deceased status, and unmerge for a merged
 * record. Fetches the dedicated /patients/[id] endpoint (identifiers +
 * contacts) rather than expanding the chart payload.
 */
export function PatientIdentityPanel({ patientId }: { patientId: string }) {
  const push = useToastStore((s) => s.push);
  const [data, setData] = useState<PatientIdentity | null>(null);
  const [addingId, setAddingId] = useState(false);
  const [idType, setIdType] = useState("ABHA");
  const [idValue, setIdValue] = useState("");
  const [addingContact, setAddingContact] = useState(false);
  const [cName, setCName] = useState("");
  const [cRelation, setCRelation] = useState("guardian");
  const [cPhone, setCPhone] = useState("");

  const load = useCallback(() => {
    fetch(`/api/hospital/patients/${patientId}`).then((r) => r.json()).then((d) => setData(d.patient ?? null));
  }, [patientId]);
  useEffect(load, [load]);

  async function addIdentifier() {
    if (!idValue.trim()) { push("Identifier value is required.", "amber"); return; }
    const res = await fetch(`/api/hospital/patients/${patientId}/identifiers`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: idType, value: idValue.trim() }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push("Identifier added.", "emerald"); setIdValue(""); setAddingId(false); load();
  }

  async function addContact() {
    if (!cName.trim() || !cPhone.trim()) { push("Name and phone are required.", "amber"); return; }
    const res = await fetch(`/api/hospital/patients/${patientId}/emergency-contacts`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: cName.trim(), relation: cRelation.trim(), phone: cPhone.trim() }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push("Contact added.", "emerald"); setCName(""); setCPhone(""); setAddingContact(false); load();
  }

  async function setDeceased(deceased: boolean) {
    const res = await fetch(`/api/hospital/patients/${patientId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deceased }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push(deceased ? "Marked deceased." : "Deceased status cleared.", deceased ? "amber" : "emerald"); load();
  }

  async function unmerge() {
    const reason = window.prompt("Reason for unmerge?");
    if (!reason) return;
    const res = await fetch(`/api/hospital/patients/unmerge`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ patientId, reason }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push("Patient unmerged.", "emerald"); load();
  }

  if (!data) return null;

  return (
    <Card className="rounded-[20px]">
      <div className="flex items-center gap-2"><Fingerprint size={14} className="text-cyan" /><CardLabel>Identity</CardLabel></div>

      {data.deceasedAt ? (
        <div className="mt-2 flex items-center justify-between">
          <StatusPill label={`Deceased ${new Date(data.deceasedAt).toLocaleDateString()}`} tone="red" className="rounded-md" />
          <button onClick={() => setDeceased(false)} className="text-[10.5px] text-text-tertiary hover:text-ink">Clear</button>
        </div>
      ) : (
        <button onClick={() => setDeceased(true)} className="mt-2 flex items-center gap-1 text-[10.5px] text-text-tertiary hover:text-red"><AlertOctagon size={10} /> Mark deceased</button>
      )}

      {data.mergedIntoId && (
        <div className="mt-2 flex items-center justify-between rounded-md bg-amber/10 px-2 py-1">
          <span className="text-[10.5px] text-amber">Merged into another record</span>
          <button onClick={unmerge} className="text-[10.5px] text-amber hover:underline">Unmerge</button>
        </div>
      )}

      <div className="mt-3">
        <div className="flex items-center justify-between">
          <p className="text-[10.5px] uppercase tracking-[0.1em] text-text-tertiary">Identifiers</p>
          <button onClick={() => setAddingId((v) => !v)} className="text-text-tertiary hover:text-cyan"><Plus size={12} /></button>
        </div>
        <div className="mt-1 space-y-0.5">
          {data.identifiers.map((i) => (
            <p key={i.id} className="text-[11.5px]"><span className="font-medium">{i.type}</span>: {i.value}{i.issuer ? ` (${i.issuer})` : ""}</p>
          ))}
          {data.identifiers.length === 0 && <p className="text-[11px] text-text-tertiary">None recorded.</p>}
        </div>
        {addingId && (
          <div className="mt-1.5 flex gap-1.5">
            <select value={idType} onChange={(e) => setIdType(e.target.value)} className="rounded-md border border-hairline bg-white px-1.5 py-1 text-[11px] outline-none">
              {IDENTIFIER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <input value={idValue} onChange={(e) => setIdValue(e.target.value)} placeholder="Value" className="flex-1 rounded-md border border-hairline bg-white px-2 py-1 text-[11px] outline-none" />
            <button onClick={addIdentifier} className="rounded-md bg-cyan px-2 py-1 text-[11px] font-medium text-ink">Add</button>
          </div>
        )}
      </div>

      <div className="mt-3">
        <div className="flex items-center justify-between">
          <p className="text-[10.5px] uppercase tracking-[0.1em] text-text-tertiary">Emergency contacts</p>
          <button onClick={() => setAddingContact((v) => !v)} className="text-text-tertiary hover:text-cyan"><Plus size={12} /></button>
        </div>
        <div className="mt-1 space-y-0.5">
          {data.emergencyContacts.map((c) => (
            <p key={c.id} className="text-[11.5px]">{c.name} <span className="text-text-tertiary">({c.relation}) · {c.phone}</span></p>
          ))}
          {data.emergencyContacts.length === 0 && <p className="text-[11px] text-text-tertiary">None recorded.</p>}
        </div>
        {addingContact && (
          <div className="mt-1.5 space-y-1">
            <div className="flex gap-1.5">
              <input value={cName} onChange={(e) => setCName(e.target.value)} placeholder="Name" className="flex-1 rounded-md border border-hairline bg-white px-2 py-1 text-[11px] outline-none" />
              <input value={cRelation} onChange={(e) => setCRelation(e.target.value)} placeholder="Relation" className="w-24 rounded-md border border-hairline bg-white px-2 py-1 text-[11px] outline-none" />
            </div>
            <div className="flex gap-1.5">
              <input value={cPhone} onChange={(e) => setCPhone(e.target.value)} placeholder="Phone" className="flex-1 rounded-md border border-hairline bg-white px-2 py-1 text-[11px] outline-none" />
              <button onClick={addContact} className="rounded-md bg-cyan px-2 py-1 text-[11px] font-medium text-ink">Add</button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
