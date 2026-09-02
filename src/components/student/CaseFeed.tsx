"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Search, Siren } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { cn } from "@/lib/utils";

interface CaseSummary {
  id: string; title: string; specialty: string; subspecialty?: string | null;
  difficulty: string; acuity: string; sourceType: string;
  patientAgeBand: string; patientSex: string; chiefComplaint: string;
}

const DIFFICULTIES = ["FOUNDATION", "INTERMEDIATE", "ADVANCED", "RESIDENT_LEVEL", "EXPERT"];
const ACUITY_TONE: Record<string, "emerald" | "amber" | "red"> = { ROUTINE: "emerald", URGENT: "amber", EMERGENCY: "red" };

export function CaseFeed({ presetAcuity, title = "Clinical Feed", subtitle }: { presetAcuity?: string; title?: string; subtitle?: string }) {
  const [cases, setCases] = useState<CaseSummary[] | null>(null);
  const [specialty, setSpecialty] = useState("all");
  const [difficulty, setDifficulty] = useState("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    const params = new URLSearchParams();
    if (specialty !== "all") params.set("specialty", specialty);
    if (difficulty !== "all") params.set("difficulty", difficulty);
    if (presetAcuity) params.set("acuity", presetAcuity);
    if (query) params.set("q", query);
    fetch(`/api/student/cases?${params.toString()}`)
      .then((r) => r.json())
      .then((d) => setCases(d.cases ?? []));
  }, [specialty, difficulty, query, presetAcuity]);

  const specialties = useMemo(() => {
    if (!cases) return [];
    return [...new Set(cases.map((c) => c.specialty))].sort();
  }, [cases]);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex items-center gap-2">
        {presetAcuity === "EMERGENCY" && <Siren size={18} className="text-red" />}
        <h1 className="text-[20px] font-semibold tracking-tight">{title}</h1>
      </div>
      {subtitle && <p className="mt-1 text-[13px] text-text-secondary">{subtitle}</p>}

      <div className="mt-5 flex flex-wrap items-center gap-2.5">
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search cases..."
            className="w-[220px] rounded-md border border-hairline bg-black/[0.025] py-2 pl-8 pr-3 text-[12.5px] outline-none focus:border-cyan/40"
          />
        </div>
        <select
          value={specialty}
          onChange={(e) => setSpecialty(e.target.value)}
          className="rounded-md border border-hairline bg-black/[0.025] px-3 py-2 text-[12.5px] outline-none focus:border-cyan/40"
        >
          <option value="all">All specialties</option>
          {specialties.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select
          value={difficulty}
          onChange={(e) => setDifficulty(e.target.value)}
          className="rounded-md border border-hairline bg-black/[0.025] px-3 py-2 text-[12.5px] outline-none focus:border-cyan/40"
        >
          <option value="all">All difficulties</option>
          {DIFFICULTIES.map((d) => <option key={d} value={d}>{d.replaceAll("_", " ")}</option>)}
        </select>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
        {cases === null && Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-[160px] animate-pulse rounded-[20px] bg-black/[0.04]" />)}
        {cases?.length === 0 && <p className="col-span-full text-[13px] text-text-tertiary">No cases match these filters.</p>}
        {cases?.map((c) => (
          <Link key={c.id} href={`/student/cases/${c.id}`}>
            <Card className={cn("h-full rounded-[20px] transition hover:border-cyan/30", c.acuity === "EMERGENCY" && "border-red/25")}>
              <div className="flex items-start justify-between gap-2">
                <p className="text-[11px] font-mono text-text-tertiary">{c.id.slice(0, 8).toUpperCase()}</p>
                <StatusPill label={c.acuity} tone={ACUITY_TONE[c.acuity]} className="rounded-md" />
              </div>
              <p className="mt-2 text-[14px] font-medium leading-snug">{c.title}</p>
              <p className="mt-1 text-[12px] text-text-secondary">{c.patientAgeBand} · {c.patientSex}</p>
              <p className="mt-1.5 line-clamp-2 text-[12px] text-text-tertiary">&ldquo;{c.chiefComplaint}&rdquo;</p>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <StatusPill label={c.specialty} tone="cyan" className="rounded-md" />
                <StatusPill label={c.difficulty.replaceAll("_", " ")} tone="neutral" className="rounded-md" />
              </div>
              <p className="mt-2 text-[10.5px] uppercase tracking-[0.08em] text-text-tertiary">Synthetic educational case</p>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
