"use client";

import { useCallback, useEffect, useState } from "react";
import { LibraryBig, Upload } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill, type StatusTone } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";

/**
 * RAG Phase 2, step 2.8 — knowledge documents (docs/RAG_IMPLEMENTATION_PLAN.md §4).
 * A hospital administrator uploads a document or its next version, follows
 * its ingestion, re-runs a failed one and withdraws a version; a medical
 * superintendent or quality lead approves or rejects (never their own
 * upload). Status only: no file contents, hash or storage reference reach
 * this screen.
 *
 * Plan §13.4: numbers highlighted in a version (12-digit numbers that aren't
 * an Aadhaar number, mobiles not on the facility's published list) are shown
 * masked, and the approver confirms each before Approve is enabled; an
 * administrator may propose an older version again (two-person approval);
 * the facility's published contact numbers are kept here.
 */
type State = "PROCESSING" | "FAILED" | "AWAITING_APPROVAL" | "SCHEDULED" | "PUBLISHED" | "SUPERSEDED" | "EXPIRED" | "WITHDRAWN" | "REJECTED";
interface Version {
  id: string; version: number; fileName: string | null; format: string | null; pageCount: number | null; byteSize: number;
  state: State; ingestionStatus: string; ingestionError: string | null; ingestionAttempts: number; chunkCount: number | null; cacheHitCount: number | null;
  uploadedBy: string | null; uploadedByMe: boolean; uploadedAt: string; approvedBy: string | null; approvedAt: string | null;
  effectiveAt: string | null; expiresAt: string | null; publishedAt: string | null; rejectedReason: string | null; scanStatus: string;
  reproposedFrom: number | null; highlights: Highlight[];
}
interface Highlight { id: string; ordinal: number; kind: "TWELVE_DIGIT_NUMBER" | "MOBILE_NUMBER"; location: "TEXT" | "DETAILS"; pageNumber: number | null; excerpt: string; acknowledgedAt: string | null }
interface Contact { id: string; kind: string; label: string; number: string }
const HIGHLIGHT: Record<Highlight["kind"], string> = { TWELVE_DIGIT_NUMBER: "A 12-digit number (not an Aadhaar number)", MOBILE_NUMBER: "A mobile number not on the facility's published list" };
const CONTACT_KINDS: [string, string][] = [["SWITCHBOARD", "Switchboard"], ["HELPLINE", "Helpline"], ["AMBULANCE", "Ambulance"], ["OTHER", "Other"]];
interface Doc { id: string; title: string; description: string | null; type: string; accessClass: string; scope: "FACILITY" | "ORGANIZATION"; versions: Version[] }
interface ListResponse { documents: Doc[]; canManage: boolean; canApprove: boolean; orgAdmin: boolean }

const STATE: Record<State, [string, StatusTone]> = {
  PROCESSING: ["Processing", "brand"], FAILED: ["Failed", "danger"], AWAITING_APPROVAL: ["Awaiting approval", "warning"],
  SCHEDULED: ["Approved, not yet in force", "brand"], PUBLISHED: ["Published", "success"], SUPERSEDED: ["Superseded", "neutral"],
  EXPIRED: ["Expired", "neutral"], WITHDRAWN: ["Withdrawn", "neutral"], REJECTED: ["Rejected", "danger"],
};
const FAILURE: Record<string, string> = {
  UNREADABLE: "The file couldn't be read.", NO_TEXT_LAYER: "A page is a scanned image with no text.", NO_TEXT: "The file has no text.",
  TOO_MANY_PAGES: "More than 500 pages.", CONTAINS_IDENTIFIERS: "It looks like it names a patient.",
  PROVIDER_UNAVAILABLE: "The embedding service was unavailable.", STORAGE_UNAVAILABLE: "The stored file couldn't be read.",
};
const TYPES: [string, string][] = [["SOP", "Standard operating procedure"], ["POLICY", "Policy"], ["CLINICAL_REFERENCE", "Clinical reference"], ["FORMULARY", "Formulary"], ["ADMIN", "Administrative"], ["EDUCATIONAL", "Educational"]];
const CLASSES: [string, string][] = [["ALL_STAFF", "All staff"], ["CLINICAL", "Clinical staff"], ["PHARMACY", "Pharmacy"], ["BILLING", "Billing"], ["ADMIN", "Administration"]];
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) : "—");
const input = "rounded-md border border-hairline bg-card px-2 py-1.5 text-[13px]";

export function KnowledgeAdmin() {
  const push = useToastStore((s) => s.push);
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newVersionOf, setNewVersionOf] = useState<string>("");
  const [reasonFor, setReasonFor] = useState<{ id: string; action: "reject" | "withdraw" } | null>(null);
  const [reason, setReason] = useState("");
  const [acked, setAcked] = useState<Set<string>>(new Set());
  const [contacts, setContacts] = useState<Contact[]>([]);

  const load = useCallback(() => {
    fetch("/api/hospital/knowledge")
      .then(async (r) => (r.ok ? (setData(await r.json()), setError(null)) : setError((await r.json().catch(() => null))?.error ?? "Knowledge documents are unavailable.")))
      .catch(() => setError("Knowledge documents are unavailable."));
  }, []);
  const loadContacts = useCallback(() => {
    fetch("/api/hospital/knowledge/contacts").then(async (r) => (r.ok ? setContacts((await r.json()).contacts) : null)).catch(() => undefined);
  }, []);
  useEffect(() => { load(); loadContacts(); }, [load, loadContacts]);

  async function addContact(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    const r = await fetch("/api/hospital/knowledge/contacts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: f.get("kind"), label: f.get("label"), number: f.get("number") }) }).catch(() => null);
    setBusy(false);
    if (!r?.ok) { push((await r?.json().catch(() => null))?.error ?? "The number wasn't added.", "red"); return; }
    push("Added to the published list.", "emerald");
    (e.target as HTMLFormElement).reset();
    loadContacts();
  }
  async function removeContact(id: string) {
    setBusy(true);
    const r = await fetch(`/api/hospital/knowledge/contacts/${id}`, { method: "DELETE" }).catch(() => null);
    setBusy(false);
    if (!r?.ok) { push("The number wasn't removed.", "red"); return; }
    push("Removed from the published list.", "emerald");
    loadContacts();
  }
  // While anything is processing, look again every few seconds.
  const processing = !!data?.documents.some((d) => d.versions.some((v) => v.state === "PROCESSING"));
  useEffect(() => {
    if (!processing) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [processing, load]);

  async function upload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    if (!(form.get("file") instanceof File) || !(form.get("file") as File).size) { push("Choose a file to upload.", "amber"); return; }
    if (newVersionOf) form.set("documentId", newVersionOf);
    setBusy(true);
    const r = await fetch("/api/hospital/knowledge", { method: "POST", body: form }).catch(() => null);
    setBusy(false);
    if (!r?.ok) { push((await r?.json().catch(() => null))?.error ?? "The upload didn't go through.", "red"); return; }
    push("Uploaded. It is being processed, then waits for approval.", "emerald");
    (e.target as HTMLFormElement).reset();
    setNewVersionOf("");
    load();
  }

  async function act(id: string, action: "approve" | "reject" | "withdraw" | "retry" | "repropose", body: Record<string, unknown> = {}) {
    setBusy(true);
    const r = await fetch(`/api/hospital/knowledge/versions/${id}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    setBusy(false);
    if (!r?.ok) { push((await r?.json().catch(() => null))?.error ?? "That didn't go through.", "red"); load(); return; }
    const res = await r.json().catch(() => ({}));
    push(action === "approve" ? (res.published ? "Approved and published." : "Approved; it comes into force on its effective date.") : action === "reject" ? "Rejected." : action === "withdraw" ? "Withdrawn." : action === "repropose" ? "Proposed again as a new version. It is processed, then needs a second person's approval." : "Queued again.", "emerald");
    setReasonFor(null); setReason("");
    load();
  }

  const newVersionTitle = data?.documents.find((d) => d.id === newVersionOf)?.title;

  return (
    <div className="mx-auto max-w-5xl" aria-label="Knowledge documents">
      <h1 className="flex items-center gap-2 text-[20px] font-semibold tracking-tight"><LibraryBig size={18} aria-hidden /> Knowledge documents</h1>
      <p className="mt-1 text-[13px] text-text-secondary">
        The hospital&apos;s SOPs, policies and formularies for the AI assistant to cite. A document is searchable only once a second person approves it.
        Documents must not name patients; a file that looks like it does is refused.
      </p>

      {data?.canManage ? (
        <Card className="mt-4">
          <CardLabel>{newVersionTitle ? `New version of “${newVersionTitle}”` : "Upload a document"}</CardLabel>
          <form onSubmit={upload} className="mt-2 grid gap-3 text-[13px] sm:grid-cols-2" aria-label="Upload a knowledge document">
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span>File (PDF, text, Markdown, HTML, CSV or JSON; up to 20 MB)</span>
              <input name="file" type="file" accept=".pdf,.txt,.md,.markdown,.html,.htm,.csv,.json" className={input} />
            </label>
            {newVersionTitle ? (
              <p className="sm:col-span-2 text-text-secondary">
                The new version replaces the current one once it is approved.{" "}
                <button type="button" onClick={() => setNewVersionOf("")} className="underline">Upload a new document instead</button>
              </p>
            ) : (
              <>
                <label className="flex flex-col gap-1 sm:col-span-2"><span>Title</span><input name="title" required minLength={3} maxLength={200} className={input} /></label>
                <label className="flex flex-col gap-1"><span>Kind of document</span>
                  <select name="documentType" className={input} defaultValue="SOP">{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                </label>
                <label className="flex flex-col gap-1"><span>Who may read it</span>
                  <select name="accessClass" className={input} defaultValue="CLINICAL">{CLASSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                </label>
                {data.orgAdmin ? (
                  <label className="flex flex-col gap-1"><span>Applies to</span>
                    <select name="scope" className={input} defaultValue="FACILITY"><option value="FACILITY">This facility</option><option value="ORGANIZATION">Every facility of the organisation</option></select>
                  </label>
                ) : null}
              </>
            )}
            <label className="flex flex-col gap-1"><span>In force from (optional)</span><input name="effectiveAt" type="date" className={input} /></label>
            <label className="flex flex-col gap-1"><span>Expires on (optional)</span><input name="expiresAt" type="date" className={input} /></label>
            <div className="sm:col-span-2">
              <button disabled={busy} className="inline-flex items-center gap-1.5 rounded-md bg-cyan px-3 py-1.5 text-[13px] font-medium text-ink disabled:opacity-50"><Upload size={14} aria-hidden /> Upload</button>
            </div>
          </form>
        </Card>
      ) : null}

      {error ? <p className="mt-4 text-[13px] text-amber">{error}</p>
        : !data ? <p className="mt-4 text-[13px] text-text-secondary">Loading…</p>
        : !data.documents.length ? <p className="mt-4 text-[13px] text-text-secondary">No knowledge documents yet.</p>
        : (
          <ul className="mt-4 space-y-3">
            {data.documents.map((d) => (
              <li key={d.id} aria-label={`Document ${d.title}`}>
                <Card>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="text-[15px] font-semibold">{d.title}</h2>
                    <span className="text-[12px] text-text-secondary">
                      {TYPES.find(([v]) => v === d.type)?.[1]} · {CLASSES.find(([v]) => v === d.accessClass)?.[1]} · {d.scope === "ORGANIZATION" ? "Every facility" : "This facility"}
                    </span>
                  </div>
                  <table className="mt-2 w-full text-left text-[12.5px]">
                    <caption className="sr-only">Versions of {d.title}</caption>
                    <thead>
                      <tr className="text-[11.5px] text-text-secondary"><th className="py-1 font-normal">Version</th><th className="font-normal">Status</th><th className="font-normal">Processing</th><th className="font-normal">Dates</th><th className="font-normal">People</th><th className="font-normal"><span className="sr-only">Actions</span></th></tr>
                    </thead>
                    <tbody>
                      {d.versions.map((v) => {
                        const [label, tone] = STATE[v.state];
                        return (
                          <tr key={v.id} aria-label={`Version ${v.version} of ${d.title}`} className="border-t border-hairline align-top">
                            <td className="py-1.5 pr-2">v{v.version}<div className="text-[11.5px] text-text-secondary">{v.fileName}{v.pageCount ? ` · ${v.pageCount} pages` : ""}{v.reproposedFrom ? ` · proposed again from v${v.reproposedFrom}` : ""}</div></td>
                            <td className="pr-2"><StatusPill label={label} tone={tone} />{v.rejectedReason ? <div className="mt-0.5 text-[11.5px] text-text-secondary">{v.rejectedReason}</div> : null}</td>
                            <td className="pr-2 text-text-secondary">
                              {v.state === "FAILED" ? <span className="text-danger">{FAILURE[v.ingestionError ?? ""] ?? "Failed."} ({v.ingestionAttempts} attempt{v.ingestionAttempts === 1 ? "" : "s"})</span>
                                : v.chunkCount !== null ? `${v.chunkCount} passages${v.cacheHitCount ? `, ${v.cacheHitCount} reused` : ""}` : v.ingestionStatus.toLowerCase()}
                              <div className="text-[11.5px]">Not virus-scanned</div>
                            </td>
                            <td className="pr-2 text-text-secondary">From {v.effectiveAt ? day(v.effectiveAt) : "approval"}{v.expiresAt ? `; expires ${day(v.expiresAt)}` : ""}</td>
                            <td className="pr-2 text-text-secondary">Uploaded by {v.uploadedByMe ? "you" : v.uploadedBy ?? "—"}{v.approvedBy ? `; approved by ${v.approvedBy}` : ""}</td>
                            <td className="py-1.5">
                              <div className="flex flex-wrap justify-end gap-1.5">
                                {data.canApprove && v.state === "AWAITING_APPROVAL" && !v.uploadedByMe ? (
                                  <>
                                    <button disabled={busy || v.highlights.some((h) => !acked.has(h.id))} title={v.highlights.some((h) => !acked.has(h.id)) ? "Confirm every highlighted number first" : undefined} onClick={() => act(v.id, "approve", { acknowledgedHighlightIds: v.highlights.filter((h) => acked.has(h.id)).map((h) => h.id) })} className="rounded-md bg-cyan px-2.5 py-1 text-[12px] font-medium text-ink disabled:opacity-50">Approve</button>
                                    <button disabled={busy} onClick={() => { setReasonFor({ id: v.id, action: "reject" }); setReason(""); }} className="rounded-md border border-hairline px-2.5 py-1 text-[12px]">Reject…</button>
                                  </>
                                ) : null}
                                {data.canApprove && v.state === "AWAITING_APPROVAL" && v.uploadedByMe ? <span className="text-[11.5px] text-text-secondary">Someone else must approve your upload</span> : null}
                                {data.canManage && v.publishedAt && ["SUPERSEDED", "EXPIRED", "WITHDRAWN"].includes(v.state) && (d.scope === "FACILITY" || data.orgAdmin) ? (
                                  <button disabled={busy} onClick={() => act(v.id, "repropose")} className="rounded-md border border-hairline px-2.5 py-1 text-[12px]">Propose again…</button>
                                ) : null}
                                {data.canManage && v.state === "FAILED" ? <button disabled={busy} onClick={() => act(v.id, "retry")} className="rounded-md border border-hairline px-2.5 py-1 text-[12px]">Re-run</button> : null}
                                {data.canManage && ["PUBLISHED", "SCHEDULED", "AWAITING_APPROVAL", "PROCESSING", "FAILED"].includes(v.state) ? (
                                  <button disabled={busy} onClick={() => { setReasonFor({ id: v.id, action: "withdraw" }); setReason(""); }} className="rounded-md border border-hairline px-2.5 py-1 text-[12px]">Withdraw…</button>
                                ) : null}
                              </div>
                              {v.highlights.length && ["AWAITING_APPROVAL", "PROCESSING"].includes(v.state) ? (
                                <fieldset className="mt-1.5 rounded-md border border-amber/50 p-2 text-left" aria-label={`Highlighted numbers in version ${v.version}`}>
                                  <legend className="px-1 text-[11.5px] font-medium">{v.highlights.length} highlighted number{v.highlights.length === 1 ? "" : "s"}: check each is not a patient&apos;s</legend>
                                  <ul className="space-y-1">
                                    {v.highlights.map((h) => (
                                      <li key={h.id} className="text-[11.5px]">
                                        <label className="flex items-start gap-1.5">
                                          {data.canApprove && !v.uploadedByMe && v.state === "AWAITING_APPROVAL" ? (
                                            <input type="checkbox" checked={acked.has(h.id)} onChange={(e) => setAcked((s) => { const n = new Set(s); if (e.target.checked) n.add(h.id); else n.delete(h.id); return n; })} aria-label={`I checked highlighted number ${h.ordinal}`} />
                                          ) : null}
                                          <span>
                                            <span className="font-medium">{HIGHLIGHT[h.kind]}</span>{h.location === "DETAILS" ? " in the file name, title or description" : h.pageNumber ? ` on page ${h.pageNumber}` : ""}:{" "}
                                            <span className="text-text-secondary">{h.excerpt}</span>
                                          </span>
                                        </label>
                                      </li>
                                    ))}
                                  </ul>
                                </fieldset>
                              ) : null}
                              {reasonFor?.id === v.id ? (
                                <div className="mt-1.5 flex flex-wrap justify-end gap-1.5">
                                  <input aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required, audited)" maxLength={500} className={`${input} min-w-[200px] py-1 text-[12px]`} />
                                  <button disabled={busy || reason.trim().length < 3} onClick={() => act(v.id, reasonFor.action, { reason })} className="rounded-md bg-cyan px-2.5 py-1 text-[12px] font-medium text-ink disabled:opacity-50">{reasonFor.action === "reject" ? "Reject" : "Withdraw"}</button>
                                  <button onClick={() => setReasonFor(null)} className="text-[12px] text-text-secondary">Cancel</button>
                                </div>
                              ) : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {data.canManage && (d.scope === "FACILITY" || data.orgAdmin) ? (
                    <button onClick={() => { setNewVersionOf(d.id); window.scrollTo({ top: 0, behavior: "smooth" }); }} className="mt-2 rounded-md border border-hairline px-2.5 py-1 text-[12px]">Upload a new version…</button>
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>
        )}

      <Card className="mt-4">
        <CardLabel>This facility&apos;s published contact numbers</CardLabel>
        <p className="mt-1 text-[12.5px] text-text-secondary">A document may print these mobile numbers (switchboard, helplines, ambulance) without a highlight. Any other mobile number is shown to the approver.</p>
        {contacts.length ? (
          <ul className="mt-2 space-y-1 text-[13px]" aria-label="Published contact numbers">
            {contacts.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{c.label}</span>
                <span className="text-text-secondary">{CONTACT_KINDS.find(([v]) => v === c.kind)?.[1]} · {c.number}</span>
                {data?.canManage ? <button disabled={busy} onClick={() => removeContact(c.id)} className="text-[12px] underline">Remove</button> : null}
              </li>
            ))}
          </ul>
        ) : <p className="mt-2 text-[13px] text-text-secondary">None yet.</p>}
        {data?.canManage ? (
          <form onSubmit={addContact} className="mt-2 flex flex-wrap items-end gap-2 text-[13px]" aria-label="Add a published contact number">
            <label className="flex flex-col gap-1"><span>For</span><select name="kind" className={input} defaultValue="SWITCHBOARD">{CONTACT_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            <label className="flex flex-col gap-1"><span>Label</span><input name="label" required minLength={2} maxLength={80} className={input} /></label>
            <label className="flex flex-col gap-1"><span>Mobile number</span><input name="number" required inputMode="tel" className={input} /></label>
            <button disabled={busy} className="rounded-md border border-hairline px-2.5 py-1.5 text-[12px]">Add</button>
          </form>
        ) : null}
      </Card>
    </div>
  );
}
