"use client";

import { ResumableUpload } from "@/components/patient-portal/ResumableUpload";
import { useCallback, useEffect, useState } from "react";
import { FileText, CheckCircle2 } from "lucide-react";
import { Card, SectionTitle, Empty, Unavailable, StatusPill, formatDate, usePatientData } from "@/components/patient-portal/ui";
import { LoadMore } from "@/components/hospital-os/shared/LoadMore";

/**
 * Week 4c — your uploads (docs/DOCUMENT_PIPELINE_DESIGN.md §6): add a report,
 * watch it being read, and review what was found. Nothing joins your record
 * until you confirm it, and confirmed entries are always labelled as yours.
 * Bulk confirm only for high-confidence printed facts whose exact-copy check
 * passed; the rest are decided one by one (the server enforces both).
 */
interface Doc { id: string; type: string; title: string; uploadedAt: string }
interface Status { status: string; processingId?: string; message?: string; facts?: Record<string, number> }
interface Fact {
  id: string; factType: string; value: Record<string, unknown>; sourceText: string | null; confidenceBand: "LOW" | "MEDIUM" | "HIGH";
  handwritten: boolean; version: number; confirmable: boolean; bulkConfirmable: boolean;
}
interface FactPage { facts: Fact[]; nextCursor: string | null; total?: number }

const RUN_LABEL: Record<string, [string, "neutral" | "good" | "warn" | "info"]> = {
  NOT_PROCESSED: ["Saved", "neutral"], QUEUED: ["Waiting to be read", "info"], RUNNING: ["Reading…", "info"],
  AWAITING_REVIEW: ["Ready for your review", "warn"], COMPLETED: ["Reviewed", "good"], FAILED: ["Couldn't read", "warn"],
  CANCELLED: ["Stopped", "neutral"], SKIPPED: ["Not read", "neutral"],
};
const OPEN = ["QUEUED", "RUNNING"];

function factLine(f: Fact): string {
  const v = f.value;
  const join = (...xs: unknown[]) => xs.filter((x) => x !== undefined && x !== null && x !== "").join(" ");
  switch (f.factType) {
    case "LAB_VALUE": return join(v.analyte, v.value, v.unit, v.referenceRange ? `(${v.referenceRange})` : "");
    case "MEDICATION": return join(v.form, v.name, v.dose, v.frequency, v.duration ? `for ${v.duration}` : "");
    case "ALLERGY": return `Allergy: ${v.substance}`;
    case "DIAGNOSIS": return `Diagnosis: ${v.text}`;
    case "PROCEDURE": return `Procedure: ${v.text}`;
    case "DOCUMENT_META": return join("Report details:", v.facilityName, v.documentDate);
    default: return f.sourceText ?? f.factType;
  }
}

function Review({ processingId, onDone }: { processingId: string; onDone: () => void }) {
  const [facts, setFacts] = useState<Fact[] | null>(null);
  // Flagship 3c: the facts come in pages (least confident first); the first says how many there are.
  const [more, setMore] = useState<{ cursor: string | null; total: number }>({ cursor: null, total: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = `/api/patient/person/facts?processingId=${encodeURIComponent(processingId)}`;
  const load = useCallback(() => {
    fetch(url).then((r) => (r.ok ? r.json() : Promise.reject())).then((p: FactPage) => { setFacts(p.facts); setMore({ cursor: p.nextCursor, total: p.total ?? p.facts.length }); })
      .catch(() => setError("Your review is unavailable right now."));
  }, [url]);
  const loadMore = useCallback(async () => {
    if (!more.cursor) return;
    const p: FactPage | null = await fetch(`${url}&cursor=${encodeURIComponent(more.cursor)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!p) { setError("The rest didn't load. Try again."); return; }
    setFacts((xs) => [...(xs ?? []), ...p.facts]);
    setMore((m) => ({ ...m, cursor: p.nextCursor }));
  }, [url, more.cursor]);
  useEffect(load, [load]);
  async function post(url: string, body: unknown) {
    setBusy(true); setError(null);
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    setBusy(false);
    if (!r?.ok) setError((await r?.json().catch(() => null))?.error ?? "That didn't go through. Try again.");
    load(); onDone();
  }
  if (error && !facts) return <p className="text-[12.5px] text-amber">{error}</p>;
  if (!facts) return <Empty>Loading what we found…</Empty>;
  if (!facts.length) return <p className="flex items-center gap-1.5 text-[12.5px] text-success"><CheckCircle2 size={13} /> Everything here is reviewed.</p>;
  const bulk = facts.filter((f) => f.bulkConfirmable);
  return (
    <div className="mt-2 space-y-2" aria-label="Review what we found">
      <p className="text-[12px] text-text-secondary">Check each line against your report. Only what you confirm is added to your record, marked as from your upload.{more.total > facts.length && ` Showing ${facts.length} of ${more.total}, least certain first.`}</p>
      {bulk.length > 1 && (
        <button disabled={busy} onClick={() => post("/api/patient/person/facts/bulk", { decisions: bulk.map((f) => ({ factId: f.id, version: f.version, decision: "CONFIRM" })) })}
          className="rounded-md bg-cyan px-3 py-1.5 text-[12px] font-medium text-ink disabled:opacity-50">
          Confirm all {bulk.length} clearly printed lines
        </button>
      )}
      <ul className="space-y-1.5">
        {facts.map((f) => (
          <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-hairline px-3 py-2 text-[13px]">
            <span>{factLine(f)}{f.handwritten && <span className="ml-1.5 text-[11px] text-text-tertiary">handwritten</span>}{f.confidenceBand === "LOW" && <span className="ml-1.5 text-[11px] text-amber">check carefully</span>}</span>
            <span className="flex gap-1.5">
              {f.confirmable && <button disabled={busy} onClick={() => post(`/api/patient/person/facts/${f.id}/confirm`, { version: f.version })} className="rounded-md border border-hairline px-2.5 py-1 text-[12px] hover:bg-black/[0.03] disabled:opacity-50">Confirm</button>}
              <button disabled={busy} onClick={() => post(`/api/patient/person/facts/${f.id}/reject`, { version: f.version })} className="rounded-md border border-hairline px-2.5 py-1 text-[12px] text-text-secondary hover:bg-black/[0.03] disabled:opacity-50">Not right</button>
            </span>
          </li>
        ))}
      </ul>
      {more.cursor && <LoadMore onLoad={loadMore} label="Show more of what we found" />}
      {error && <p className="text-[12px] text-amber">{error}</p>}
    </div>
  );
}

function DocumentRow({ doc }: { doc: Doc }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    fetch(`/api/patient/person/documents/${doc.id}/processing`).then((r) => (r.ok ? r.json() : null)).then((s) => alive && setStatus(s)).catch(() => undefined);
    return () => { alive = false; };
  }, [doc.id, tick]);
  // While it's being read (or just uploaded, before its run starts), look again every two seconds.
  useEffect(() => {
    const fresh = Date.now() - new Date(doc.uploadedAt).getTime() < 10 * 60_000;
    if (status && !OPEN.includes(status.status) && !(status.status === "NOT_PROCESSED" && fresh)) return;
    const t = setTimeout(() => setTick((n) => n + 1), 2000);
    return () => clearTimeout(t);
  }, [status, tick, doc.uploadedAt]);
  const [label, tone] = RUN_LABEL[status?.status ?? "QUEUED"] ?? [status?.status ?? "", "neutral"];
  return (
    <li className="border-b border-hairline pb-3 last:border-0 last:pb-0" data-document-id={doc.id}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <FileText size={16} className="text-cyan" />
          <div>
            <div className="text-[14px] font-medium">{doc.title}</div>
            <div className="text-[12px] text-text-secondary">Added {formatDate(doc.uploadedAt)}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {status?.status === "AWAITING_REVIEW" && status.processingId && (
            <button onClick={() => setOpen(!open)} aria-expanded={open} className="rounded-md border border-hairline px-2.5 py-1 text-[12px] hover:bg-black/[0.03]">{open ? "Close" : "Review"}</button>
          )}
          <StatusPill label={label} tone={tone} />
        </div>
      </div>
      {status?.status === "FAILED" && status.message && <p className="mt-1 text-[12px] text-text-secondary">{status.message}</p>}
      {open && status?.processingId && <Review processingId={status.processingId} onDone={() => setTick((n) => n + 1)} />}
    </li>
  );
}

export default function DocumentsPage() {
  const { state, reload } = usePatientData<{ documents: Doc[] }>("/api/patient/person/documents");
  return (
    <div className="space-y-5">
      <h1 className="text-[18px] font-semibold">My documents</h1>
      <Card>
        <SectionTitle>Add a report</SectionTitle>
        <ResumableUpload onUploaded={reload} />
        <p className="mt-2 text-[12px] text-text-secondary">PDFs and photos of lab reports, prescriptions and discharge summaries. The file is kept exactly as you uploaded it.</p>
      </Card>
      <Card>
        <SectionTitle>Your uploads</SectionTitle>
        {state.status === "loading" ? <Empty>Loading…</Empty> : state.status === "error" ? <Unavailable label="Your documents" /> : state.data.documents.length === 0 ? (
          <Empty>Nothing uploaded yet.</Empty>
        ) : (
          <ul className="space-y-3">{state.data.documents.map((d) => <DocumentRow key={d.id} doc={d} />)}</ul>
        )}
      </Card>
    </div>
  );
}
