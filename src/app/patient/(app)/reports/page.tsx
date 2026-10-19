"use client";

import { useState } from "react";
import { FlaskConical, Scan, FileText } from "lucide-react";
import { PatientAi } from "@/components/ai/PatientAi";
import { Card, SectionTitle, Empty, Unavailable, usePatientData, formatDate, StatusPill } from "@/components/patient-portal/ui";

interface Report { id: string; kind: "LAB" | "IMAGING" | "DOCUMENT"; title: string; date: string; downloadable: boolean; }

export default function ReportsPage() {
  const { state } = usePatientData<{ reports: Report[] }>("/api/patient/reports");
  // The report being explained: its source id (the part after "lab:", "imaging:", "document:" or "upload:").
  const [explaining, setExplaining] = useState<string | null>(null);
  const icon = (k: string) => (k === "LAB" ? FlaskConical : k === "IMAGING" ? Scan : FileText);
  return (
    <div className="space-y-5">
      <h1 className="text-[18px] font-semibold">Reports</h1>
      <Card>
        <SectionTitle>Released to you</SectionTitle>
        {state.status === "loading" ? <Empty>Loading…</Empty> : state.status === "error" ? <Unavailable label="Reports" /> : state.data.reports.length === 0 ? (
          <Empty>No reports have been released to you yet. Reports appear here once your clinician finalizes them.</Empty>
        ) : (
          <ul className="space-y-3">
            {state.data.reports.map((r) => {
              const Icon = icon(r.kind);
              return (
                <li key={r.id} className="flex items-center justify-between border-b border-hairline pb-3 last:border-0 last:pb-0">
                  <div className="flex items-center gap-3">
                    <Icon size={16} className="text-cyan" />
                    <div>
                      <div className="text-[14px] font-medium">{r.title}</div>
                      <div className="text-[12px] text-text-secondary">{formatDate(r.date)}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setExplaining(explaining === r.id ? null : r.id)} className="rounded-md border border-hairline px-2.5 py-1 text-[12px] hover:bg-black/[0.03]" aria-expanded={explaining === r.id}>
                      {explaining === r.id ? "Close" : "Explain"}
                    </button>
                    <StatusPill label="Released" tone="good" />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      {explaining && <PatientAi key={explaining} modes={["EXPLAIN_REPORT"]} documentId={explaining.split(":").slice(1).join(":")} title="Explain this report (AI, advisory — not a diagnosis)" />}
    </div>
  );
}
