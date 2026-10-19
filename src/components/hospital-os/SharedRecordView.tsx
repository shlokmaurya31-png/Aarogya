"use client";

import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { ChartAi } from "@/components/ai/ChartAi";
import { SharedRecordSections, type SharedRecordData } from "./SharedRecordSections";

/** Week 4c — a record shared through an approved access request, with the AI over exactly that share. */
export function SharedRecordView({ shareId }: { shareId: string }) {
  const [data, setData] = useState<(SharedRecordData & { patient: { id: string; fullName: string; uhid: string } }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`/api/hospital/shares/${shareId}`).then(async (r) => {
      if (!alive) return;
      if (!r.ok) return setError("This shared record isn't available to you — it may have ended, or been withdrawn by the patient.");
      setData(await r.json());
    }).catch(() => alive && setError("This shared record isn't available right now."));
    return () => { alive = false; };
  }, [shareId]);
  if (error) return <p className="mx-auto max-w-lg rounded-2xl border border-hairline p-6 text-center text-[13px] text-text-secondary">{error}</p>;
  if (!data) return <div className="mx-auto h-64 max-w-4xl animate-pulse rounded-2xl bg-fill-muted" />;
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex items-center gap-2.5 rounded-2xl border border-accent/30 bg-accent/[0.06] p-4">
        <ShieldCheck size={18} className="text-brand" />
        <p className="text-[14px] font-semibold">{data.patient.fullName} · <span className="font-normal text-text-secondary">{data.patient.uhid}</span> · <span className="font-normal text-text-secondary">shared with you by the patient</span></p>
      </div>
      <ChartAi patientId={data.patient.id} shareId={shareId} title="Visit brief from the shared record (cited, advisory)" />
      <SharedRecordSections data={data} />
    </div>
  );
}
