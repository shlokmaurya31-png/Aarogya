"use client";

import { Pill, FlaskConical, TriangleAlert, Scan, FileText, Upload } from "lucide-react";

/**
 * Week 4c — a shared record as the doctor sees it (docs/CONSENT_SHARING_DESIGN.md §2, §8):
 * the sections the patient shared and allergies (always), nothing else. A
 * section that wasn't shared isn't rendered; the header says what was shared.
 */
const CATEGORY_LABEL: Record<string, string> = {
  PRESCRIPTIONS: "Prescriptions", LABS: "Labs", IMAGING: "Imaging", DISCHARGE_SUMMARIES: "Discharge summaries", UPLOADS: "Patient uploads",
};

export interface SharedRecordData {
  shared: { categories: string[]; sensitiveCategories: string[]; period: { from: string | null; to: string | null }; expiresAt: string | null; legacy: boolean };
  allergies: { id: string; substance: string; reaction: string | null; severity: string | null }[];
  medicationOrders?: { id: string; drugName: string; dose: string; status: string; createdAt: string }[];
  labResults?: { id: string; test: string; value: string; unit: string | null; flag: string | null; resultedAt: string }[];
  imagingReports?: { id: string; study: string; impression: string; reportedAt: string }[];
  dischargeSummaries?: { id: string; dischargedAt: string; dischargeType: string | null }[];
  uploads?: { documents: { id: string; title: string; uploadedAt: string }[]; entries: { id: string; text: string; date: string }[] };
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

export function SharedRecordSections({ data }: { data: SharedRecordData }) {
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
        {data.uploads && (
          <Section icon={<Upload />} title="From the patient's uploads (patient-provided)" count={data.uploads.entries.length}>
            {data.uploads.entries.length || data.uploads.documents.length ? (
              <div className="space-y-2 text-[12.5px] text-text-secondary">
                <ul className="space-y-1">{data.uploads.entries.map((e) => <li key={e.id}>{e.text} <span className="text-text-tertiary">· {day(e.date)}</span></li>)}</ul>
                {data.uploads.documents.length > 0 && <p className="text-text-tertiary">Documents: {data.uploads.documents.map((d) => d.title).join(", ")}</p>}
              </div>
            ) : none("Nothing uploaded in what was shared.")}
          </Section>
        )}
      </div>
    </div>
  );
}
