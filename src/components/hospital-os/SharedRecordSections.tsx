"use client";

import { useState } from "react";
import { Pill, FlaskConical, TriangleAlert, Scan, FileText, Upload, Stethoscope, HeartPulse, NotebookPen } from "lucide-react";

/**
 * Week 4c — a shared record as the doctor sees it (docs/CONSENT_SHARING_DESIGN.md §2, §8):
 * the sections the patient shared and allergies (always), nothing else. A
 * section that wasn't shared isn't rendered; the header says what was shared.
 * 4c fix: conditions, vitals and clinical notes, and the patient's uploaded
 * files open through a 5-minute signed URL after the server's access check.
 */
const CATEGORY_LABEL: Record<string, string> = {
  PRESCRIPTIONS: "Prescriptions", LABS: "Labs", IMAGING: "Imaging", DISCHARGE_SUMMARIES: "Discharge summaries", UPLOADS: "Patient uploads",
  CONDITIONS: "Conditions", VITALS: "Vitals", CLINICAL_NOTES: "Clinical notes",
};

export interface SharedRecordData {
  shared: { categories: string[]; sensitiveCategories: string[]; period: { from: string | null; to: string | null }; expiresAt: string | null; legacy: boolean };
  allergies: { id: string; substance: string; reaction: string | null; severity: string | null }[];
  medicationOrders?: { id: string; drugName: string; dose: string; status: string; createdAt: string }[];
  labResults?: { id: string; test: string; value: string; unit: string | null; flag: string | null; resultedAt: string }[];
  imagingReports?: { id: string; study: string; impression: string; reportedAt: string }[];
  dischargeSummaries?: { id: string; dischargedAt: string; dischargeType: string | null }[];
  conditions?: { diagnoses: { id: string; diagnosis: string; code: string | null; status: string; recordedAt: string }[]; problems: { id: string; diagnosis: string; code: string | null; status: string; recordedAt: string }[] };
  vitals?: { id: string; hr: number | null; sbp: number | null; dbp: number | null; rr: number | null; spo2: number | null; tempC: number | null; recordedAt: string }[];
  clinicalNotes?: { id: string; type: string; content: unknown; signedAt: string }[];
  uploads?: { documents: { id: string; title: string; uploadedAt: string }[]; entries: { id: string; text: string; date: string }[] };
}

const noteText = (c: unknown): string => (typeof c === "string" ? c : c && typeof c === "object" ? Object.values(c).filter((v) => typeof v === "string").join(" · ") : "");
const vitalsText = (v: NonNullable<SharedRecordData["vitals"]>[number]) =>
  [v.hr != null && `HR ${v.hr}`, v.sbp != null && v.dbp != null && `BP ${v.sbp}/${v.dbp}`, v.rr != null && `RR ${v.rr}`, v.spo2 != null && `SpO2 ${v.spo2}%`, v.tempC != null && `${v.tempC} °C`].filter(Boolean).join(", ");

/** Opens an upload: the server checks the share, then returns a 5-minute signed URL. */
function OpenUpload({ shareRef, id, title }: { shareRef: string; id: string; title: string }) {
  const [state, setState] = useState<"idle" | "busy" | "gone">("idle");
  async function open() {
    setState("busy");
    const r = await fetch(`/api/hospital/shares/${shareRef}/documents/${id}/download`).catch(() => null);
    const body = r?.ok ? await r.json().catch(() => null) : null;
    if (body?.url) { window.open(body.url, "_blank", "noopener"); setState("idle"); } else setState("gone");
  }
  return (
    <li className="flex items-center justify-between gap-2">
      <span>{title}</span>
      {state === "gone" ? <span className="text-[11.5px] text-text-tertiary">Not available</span> : (
        <button onClick={open} disabled={state === "busy"} className="rounded-md border border-hairline px-2 py-0.5 text-[11.5px] hover:border-brand/40 disabled:opacity-50" aria-label={`Open ${title}`}>Open</button>
      )}
    </li>
  );
}

const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" }) : "");

function Section({ icon, title, count, children }: { icon: React.ReactNode; title: string; count?: number; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-hairline bg-card p-4" aria-label={title}>
      <div className="mb-2.5 flex items-center gap-2">
        <span className="text-brand [&>svg]:size-[15px]">{icon}</span>
        <p className="text-[13px] font-semibold">{title}</p>
        {typeof count === "number" && <span className="text-[11px] text-text-tertiary">({count})</span>}
      </div>
      {children}
    </div>
  );
}
const none = (t: string) => <p className="text-[12.5px] text-text-tertiary">{t}</p>;

export function SharedRecordSections({ data, shareRef }: { data: SharedRecordData; shareRef?: string }) {
  const s = data.shared;
  return (
    <div className="space-y-4">
      <p className="rounded-xl border border-hairline bg-fill-subtle px-3 py-2 text-[12px] text-text-secondary" aria-label="What is shared">
        Shared: {s.categories.map((c) => CATEGORY_LABEL[c] ?? c).join(", ")}, and allergies
        {s.period.from || s.period.to ? ` · records ${s.period.from ? `from ${day(s.period.from)}` : ""}${s.period.to ? ` to ${day(s.period.to)}` : ""}` : ""}
        {s.sensitiveCategories.length ? ` · includes ${s.sensitiveCategories.length} sensitive categor${s.sensitiveCategories.length > 1 ? "ies" : "y"} the patient chose` : ""}
        {s.expiresAt ? ` · until ${new Date(s.expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}` : ""}
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <Section icon={<TriangleAlert />} title="Allergies" count={data.allergies.length}>
          {data.allergies.length ? (
            <ul className="space-y-1 text-[12.5px]">{data.allergies.map((a) => <li key={a.id} className="text-danger">{a.substance}{a.reaction ? ` — ${a.reaction}` : ""}{a.severity ? ` (${a.severity})` : ""}</li>)}</ul>
          ) : none("No known allergies recorded.")}
        </Section>
        {data.medicationOrders && (
          <Section icon={<Pill />} title="Medications" count={data.medicationOrders.length}>
            {data.medicationOrders.length ? (
              <ul className="space-y-1 text-[12.5px] text-text-secondary">{data.medicationOrders.slice(0, 20).map((m) => <li key={m.id}>{m.drugName} {m.dose} <span className="text-text-tertiary">· {m.status} · {day(m.createdAt)}</span></li>)}</ul>
            ) : none("No medication orders in what was shared.")}
          </Section>
        )}
        {data.labResults && (
          <Section icon={<FlaskConical />} title="Lab results" count={data.labResults.length}>
            {data.labResults.length ? (
              <ul className="space-y-1 text-[12.5px] text-text-secondary">{data.labResults.slice(0, 30).map((l) => (
                <li key={l.id} className={l.flag && l.flag !== "NORMAL" ? "text-amber" : ""}>{l.test}: {l.value}{l.unit ? ` ${l.unit}` : ""}{l.flag && l.flag !== "NORMAL" ? ` (${l.flag})` : ""} <span className="text-text-tertiary">· {day(l.resultedAt)}</span></li>
              ))}</ul>
            ) : none("No lab results in what was shared.")}
          </Section>
        )}
        {data.imagingReports && (
          <Section icon={<Scan />} title="Imaging" count={data.imagingReports.length}>
            {data.imagingReports.length ? (
              <ul className="space-y-1.5 text-[12.5px] text-text-secondary">{data.imagingReports.map((r) => <li key={r.id}><span className="font-medium text-text-primary">{r.study}</span> · {day(r.reportedAt)}<br />{r.impression}</li>)}</ul>
            ) : none("No imaging reports in what was shared.")}
          </Section>
        )}
        {data.dischargeSummaries && (
          <Section icon={<FileText />} title="Discharge summaries" count={data.dischargeSummaries.length}>
            {data.dischargeSummaries.length ? (
              <ul className="space-y-1 text-[12.5px] text-text-secondary">{data.dischargeSummaries.map((d) => <li key={d.id}>Discharged {day(d.dischargedAt)}{d.dischargeType ? ` · ${d.dischargeType}` : ""}</li>)}</ul>
            ) : none("No discharge summaries in what was shared.")}
          </Section>
        )}
        {data.conditions && (
          <Section icon={<Stethoscope />} title="Conditions" count={data.conditions.diagnoses.length + data.conditions.problems.length}>
            {data.conditions.diagnoses.length || data.conditions.problems.length ? (
              <ul className="space-y-1 text-[12.5px] text-text-secondary">
                {data.conditions.problems.map((p) => <li key={p.id}><span className="font-medium text-text-primary">{p.diagnosis}</span>{p.code ? ` (${p.code})` : ""} <span className="text-text-tertiary">· problem list · {p.status.toLowerCase()} · {day(p.recordedAt)}</span></li>)}
                {data.conditions.diagnoses.map((d) => <li key={d.id}><span className="font-medium text-text-primary">{d.diagnosis}</span>{d.code ? ` (${d.code})` : ""} <span className="text-text-tertiary">· diagnosis · {d.status.toLowerCase()} · {day(d.recordedAt)}</span></li>)}
              </ul>
            ) : none("No conditions in what was shared.")}
          </Section>
        )}
        {data.vitals && (
          <Section icon={<HeartPulse />} title="Vitals" count={data.vitals.length}>
            {data.vitals.length ? (
              <ul className="space-y-1 text-[12.5px] text-text-secondary">{data.vitals.slice(0, 10).map((v) => <li key={v.id}>{vitalsText(v) || "—"} <span className="text-text-tertiary">· {day(v.recordedAt)}</span></li>)}</ul>
            ) : none("No vitals in what was shared.")}
          </Section>
        )}
        {data.clinicalNotes && (
          <Section icon={<NotebookPen />} title="Clinical notes" count={data.clinicalNotes.length}>
            {data.clinicalNotes.length ? (
              <ul className="space-y-1.5 text-[12.5px] text-text-secondary">{data.clinicalNotes.slice(0, 10).map((n) => <li key={n.id}><span className="font-medium text-text-primary">{n.type}</span> · {day(n.signedAt)}<br />{noteText(n.content).slice(0, 400)}</li>)}</ul>
            ) : none("No clinical notes in what was shared.")}
          </Section>
        )}
        {data.uploads && (
          <Section icon={<Upload />} title="From the patient's uploads (patient-provided)" count={data.uploads.entries.length}>
            {data.uploads.entries.length || data.uploads.documents.length ? (
              <div className="space-y-2 text-[12.5px] text-text-secondary">
                <ul className="space-y-1">{data.uploads.entries.map((e) => <li key={e.id}>{e.text} <span className="text-text-tertiary">· {day(e.date)}</span></li>)}</ul>
                {data.uploads.documents.length > 0 && (shareRef ? (
                  <ul className="space-y-1" aria-label="Uploaded files">{data.uploads.documents.map((d) => <OpenUpload key={d.id} shareRef={shareRef} id={d.id} title={d.title} />)}</ul>
                ) : <p className="text-text-tertiary">Documents: {data.uploads.documents.map((d) => d.title).join(", ")}</p>)}
              </div>
            ) : none("Nothing uploaded in what was shared.")}
          </Section>
        )}
      </div>
    </div>
  );
}
