"use client";

import { useEffect, useState, useCallback } from "react";
import { FileText, Plus, History } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";

interface Document {
  id: string;
  type: string;
  title: string;
  version: number;
  status: string;
  accessPolicy: string;
  createdAt: string;
}

const DOC_TYPES = ["REPORT", "CONSENT_FORM", "REFERRAL_LETTER", "DISCHARGE_SUMMARY", "ID_PROOF", "OTHER"];

/**
 * Clinical documents panel (Phase 6.9) — lists the patient's current
 * documents, records new document metadata, and creates a new version of an
 * existing document (non-destructive; the prior version is kept, marked
 * SUPERSEDED). Reuses the documents API's facility-scoped, audited endpoints.
 */
export function PatientDocumentsPanel({ patientId, encounterId }: { patientId: string; encounterId?: string | null }) {
  const push = useToastStore((s) => s.push);
  const [docs, setDocs] = useState<Document[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [type, setType] = useState("REPORT");
  const [title, setTitle] = useState("");

  const load = useCallback(() => {
    fetch(`/api/hospital/documents?patientId=${patientId}`).then((r) => r.json()).then((d) => setDocs(d.documents ?? []));
  }, [patientId]);
  useEffect(load, [load]);

  async function addDocument() {
    if (!title.trim()) { push("Title is required.", "amber"); return; }
    const res = await fetch(`/api/hospital/documents`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patientId, encounterId: encounterId ?? undefined, type, title: title.trim() }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push("Document recorded.", "emerald"); setTitle(""); setAdding(false); load();
  }

  async function newVersion(id: string) {
    const title = window.prompt("New version title (leave blank to keep the same)?");
    if (title === null) return;
    const res = await fetch(`/api/hospital/documents/${id}/version`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(title.trim() ? { title: title.trim() } : {}),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push("New document version created.", "emerald"); load();
  }

  return (
    <Card className="rounded-[20px]">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2"><FileText size={14} className="text-cyan" /><CardLabel>Documents</CardLabel></div>
        <button onClick={() => setAdding((v) => !v)} className="text-text-tertiary hover:text-cyan"><Plus size={13} /></button>
      </div>

      {adding && (
        <div className="mt-2 flex gap-1.5">
          <select value={type} onChange={(e) => setType(e.target.value)} className="rounded-md border border-hairline bg-white px-1.5 py-1 text-[11px] outline-none">
            {DOC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className="flex-1 rounded-md border border-hairline bg-white px-2 py-1 text-[11px] outline-none" />
          <button onClick={addDocument} className="rounded-md bg-cyan px-2 py-1 text-[11px] font-medium text-ink">Add</button>
        </div>
      )}

      <div className="mt-2 space-y-1.5">
        {docs?.map((d) => (
          <div key={d.id} className="flex items-center justify-between text-[11.5px]">
            <span>
              <span className="font-medium">{d.type}</span>: {d.title}
              {d.version > 1 && <span className="text-text-tertiary"> · v{d.version}</span>}
              {d.accessPolicy === "RESTRICTED" && <StatusPill label="Restricted" tone="amber" className="ml-1 rounded-md" />}
            </span>
            <button onClick={() => newVersion(d.id)} className="flex items-center gap-0.5 text-[10.5px] text-text-tertiary hover:text-cyan"><History size={10} /> New version</button>
          </div>
        ))}
        {docs?.length === 0 && <p className="text-[11px] text-text-tertiary">No documents recorded.</p>}
      </div>
    </Card>
  );
}
