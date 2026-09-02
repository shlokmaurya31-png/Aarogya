"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { FilePlus } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";

interface EducatorCase { id: string; slug: string; title: string; specialty: string; difficulty: string; acuity: string; sourceType: string; isPublished: boolean }

export default function EducatorCasesPage() {
  const [cases, setCases] = useState<EducatorCase[] | null>(null);

  useEffect(() => {
    fetch("/api/educator/cases").then((r) => r.json()).then((d) => setCases(d.cases ?? []));
  }, []);

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">Cases</h1>
          <p className="mt-1 text-[13px] text-text-secondary">All cases visible to students, plus your own drafts.</p>
        </div>
        <Link href="/educator/cases/create" className="flex items-center gap-1.5 rounded-md bg-cyan px-3.5 py-2 text-[12.5px] font-medium text-ink hover:brightness-110">
          <FilePlus size={13} /> Create case
        </Link>
      </div>

      <div className="mt-5 space-y-2">
        {cases === null && <p className="text-[13px] text-text-tertiary">Loading...</p>}
        {cases?.map((c) => (
          <Card key={c.id} className="flex items-center justify-between rounded-lg">
            <div>
              <p className="text-[13.5px] font-medium">{c.title}</p>
              <p className="text-[11.5px] text-text-tertiary">{c.slug} · {c.specialty} · {c.difficulty}</p>
            </div>
            <div className="flex items-center gap-1.5">
              <StatusPill label={c.sourceType.replaceAll("_", " ")} tone="neutral" className="rounded-md" />
              <StatusPill label={c.isPublished ? "Published" : "Draft"} tone={c.isPublished ? "emerald" : "amber"} className="rounded-md" />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
