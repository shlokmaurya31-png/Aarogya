"use client";

import { Card, SectionTitle, Empty, Unavailable, usePatientData, formatDate, formatDateTime } from "@/components/patient-portal/ui";

interface RecordsData {
  visits: { date: string; department: string | null; statusLabel: string; reason: string | null }[];
  problems: { name: string; since: string | null }[];
  allergies: { substance: string; reaction: string | null; severity: string | null }[];
  timeline: { timestamp: string; type: string; summary: string; department: string | null }[];
}

export default function RecordsPage() {
  const { state } = usePatientData<RecordsData>("/api/patient/records");
  if (state.status === "loading") return <Empty>Loading your record…</Empty>;
  if (state.status === "error") return <Unavailable label="Your record" />;
  const r = state.data;
  return (
    <div className="space-y-5">
      <h1 className="text-[18px] font-semibold">Your health record</h1>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <SectionTitle>Active conditions</SectionTitle>
          {r.problems.length ? <ul className="space-y-1">{r.problems.map((p, i) => <li key={i} className="text-[13px]">{p.name}<span className="text-text-tertiary"> · since {formatDate(p.since)}</span></li>)}</ul> : <Empty>None recorded.</Empty>}
        </Card>
        <Card>
          <SectionTitle>Allergies</SectionTitle>
          {r.allergies.length ? <ul className="space-y-1">{r.allergies.map((a, i) => <li key={i} className="text-[13px]">{a.substance}{a.severity ? ` (${a.severity})` : ""}</li>)}</ul> : <Empty>None recorded.</Empty>}
        </Card>
      </div>

      <Card>
        <SectionTitle>Visits</SectionTitle>
        {r.visits.length ? (
          <ul className="space-y-2">{r.visits.slice(0, 20).map((v, i) => <li key={i} className="flex justify-between text-[13px]"><span>{v.department ?? "Visit"}{v.reason ? ` — ${v.reason}` : ""}</span><span className="text-text-tertiary">{formatDate(v.date)} · {v.statusLabel}</span></li>)}</ul>
        ) : <Empty>No visits recorded.</Empty>}
      </Card>

      <Card>
        <SectionTitle>Timeline</SectionTitle>
        {r.timeline.length ? (
          <ul className="space-y-2">{r.timeline.slice(0, 40).map((t, i) => <li key={i} className="border-l-2 border-hairline pl-3 text-[13px]"><span className="text-text-tertiary">{formatDateTime(t.timestamp)}</span> · {t.summary}</li>)}</ul>
        ) : <Empty>Nothing to show yet.</Empty>}
      </Card>
    </div>
  );
}
