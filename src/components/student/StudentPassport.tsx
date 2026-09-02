"use client";

import { useEffect, useState } from "react";
import { IdCard, ShieldCheck, Trophy, Stethoscope } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";

export function StudentPassport() {
  const [dashboard, setDashboard] = useState<any>(null); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [progress, setProgress] = useState<any>(null); // eslint-disable-line @typescript-eslint/no-explicit-any

  useEffect(() => {
    fetch("/api/student/dashboard").then((r) => r.json()).then(setDashboard);
    fetch("/api/student/progress").then((r) => r.json()).then(setProgress);
  }, []);

  if (!dashboard) return <div className="mx-auto max-w-3xl animate-pulse"><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-[20px] font-semibold tracking-tight">Clinical Passport</h1>
      <p className="mt-1 text-[13px] text-text-secondary">
        A record of verified identity, achievements and competencies within Aarogya Scholar. Not a formal
        medical credential or license.
      </p>

      <Card className="mt-5 rounded-[20px] bg-gradient-to-br from-cyan/[0.06] to-transparent">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-cyan/10">
            <IdCard size={20} className="text-cyan" />
          </div>
          <div>
            <p className="text-[15px] font-semibold">{dashboard.profile.fullLegalName}</p>
            <p className="text-[12px] text-text-tertiary">{dashboard.profile.course.replaceAll("_", " ")} · Year {dashboard.profile.academicYear}</p>
          </div>
          <StatusPill label="Verified" tone="emerald" className="ml-auto rounded-md" />
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3 border-t border-hairline pt-4 text-center">
          <div><p className="text-[18px] font-semibold tabular-nums">{dashboard.totalCasesCompleted}</p><p className="text-[10.5px] text-text-tertiary">Cases completed</p></div>
          <div><p className="text-[18px] font-semibold tabular-nums">{dashboard.achievements.length}</p><p className="text-[10.5px] text-text-tertiary">Achievements</p></div>
          <div><p className="text-[18px] font-semibold tabular-nums">{dashboard.profile.clinicalXp}</p><p className="text-[10.5px] text-text-tertiary">Clinical XP</p></div>
        </div>
      </Card>

      <Card className="mt-4 rounded-[20px]">
        <div className="flex items-center gap-2"><Stethoscope size={14} className="text-cyan" /><CardLabel>Specialties explored</CardLabel></div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {progress?.specialtyPerformance?.length ? progress.specialtyPerformance.map((s: any) => ( // eslint-disable-line @typescript-eslint/no-explicit-any
            <StatusPill key={s.specialty} label={`${s.specialty} (${s.count})`} tone="cyan" className="rounded-md" />
          )) : <p className="text-[12.5px] text-text-tertiary">No cases completed yet.</p>}
        </div>
      </Card>

      <Card className="mt-4 rounded-[20px]">
        <div className="flex items-center gap-2"><ShieldCheck size={14} className="text-cyan" /><CardLabel>Competencies</CardLabel></div>
        <div className="mt-3 space-y-2">
          {dashboard.competencies.length === 0 && <p className="text-[12.5px] text-text-tertiary">No competency data yet.</p>}
          {dashboard.competencies.map((c: any) => ( // eslint-disable-line @typescript-eslint/no-explicit-any
            <div key={c.domain} className="flex items-center justify-between text-[12.5px]">
              <span>{c.domain}</span>
              <span className="tabular-nums text-text-tertiary">{c.score}% ({c.attempts} attempts)</span>
            </div>
          ))}
        </div>
      </Card>

      <Card className="mt-4 rounded-[20px]">
        <div className="flex items-center gap-2"><Trophy size={14} className="text-amber" /><CardLabel>Achievements</CardLabel></div>
        <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          {dashboard.achievements.length === 0 && <p className="col-span-full text-[12.5px] text-text-tertiary">No achievements yet.</p>}
          {dashboard.achievements.map((a: any) => ( // eslint-disable-line @typescript-eslint/no-explicit-any
            <div key={a.code} className="rounded-lg border border-hairline p-3 text-center">
              <Trophy size={16} className="mx-auto text-amber" />
              <p className="mt-1.5 text-[11.5px] font-medium">{a.title}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
