"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  Flame, Trophy, ArrowRight, Siren, CalendarClock, Target, Sparkles, BookOpen,
} from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import {
  RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar, ResponsiveContainer,
} from "recharts";

interface DashboardData {
  profile: {
    fullLegalName: string; preferredName: string | null; course: string; learningTrack: string;
    academicYear: number; currentRotation: string | null; streakDays: number; clinicalXp: number;
  };
  continueCase: { attemptId: string; caseId: string; title: string; stage: string } | null;
  caseOfTheDay: { id: string; title: string; specialty: string; difficulty: string; acuity: string; chiefComplaint: string; patientAgeBand: string; patientSex: string } | null;
  emergencyChallenge: { id: string; title: string; specialty: string } | null;
  recentAttempts: { caseId: string; title: string; specialty: string; score: number | null; passed: boolean | null; submittedAt: string }[];
  competencies: { domain: string; score: number; attempts: number }[];
  weakestDomain: string | null;
  achievements: { code: string; title: string; description: string; earnedAt: string }[];
  recommended: { id: string; title: string; specialty: string; difficulty: string }[];
  totalCasesAvailable: number;
  totalCasesCompleted: number;
}

export function StudentDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/student/dashboard")
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? "Failed to load dashboard.");
        return res.json();
      })
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <ErrorState message={error} />;
  if (!data) return <LoadingSkeleton />;

  const greetingName = data.profile.preferredName || data.profile.fullLegalName.split(" ")[0];
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  return (
    <div className="mx-auto max-w-6xl">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">{greeting}, {greetingName}</h1>
        <p className="mt-1 text-[13px] text-text-secondary">
          {data.profile.course.replaceAll("_", " ")} · Year {data.profile.academicYear} · Rotation: {data.profile.currentRotation ?? "—"}
        </p>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile icon={Flame} label="Streak" value={`${data.profile.streakDays}d`} tone="amber" />
        <StatTile icon={Sparkles} label="Clinical XP" value={data.profile.clinicalXp.toLocaleString()} tone="cyan" />
        <StatTile icon={Target} label="Cases completed" value={`${data.totalCasesCompleted}/${data.totalCasesAvailable}`} tone="emerald" />
        <StatTile icon={Trophy} label="Achievements" value={String(data.achievements.length)} tone="cyan" />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {data.continueCase && (
            <Card className="rounded-[20px] border-cyan/25 bg-cyan/[0.04]">
              <CardLabel>Continue case</CardLabel>
              <p className="mt-2 text-[15px] font-medium">{data.continueCase.title}</p>
              <p className="mt-1 text-[12px] text-text-tertiary">Stage: {data.continueCase.stage.replaceAll("_", " ")}</p>
              <Link
                href={`/student/cases/${data.continueCase.caseId}`}
                className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-cyan px-3.5 py-2 text-[12.5px] font-medium text-ink hover:brightness-110"
              >
                Resume <ArrowRight size={13} />
              </Link>
            </Card>
          )}

          {data.caseOfTheDay && (
            <Card className="rounded-[20px]">
              <div className="flex items-center justify-between">
                <CardLabel>Case of the day</CardLabel>
                <StatusPill label={data.caseOfTheDay.acuity} tone={data.caseOfTheDay.acuity === "EMERGENCY" ? "red" : "cyan"} className="rounded-md" />
              </div>
              <p className="mt-2 text-[15px] font-medium">{data.caseOfTheDay.title}</p>
              <p className="mt-1 text-[12.5px] text-text-secondary">
                {data.caseOfTheDay.patientAgeBand} · {data.caseOfTheDay.patientSex} · {data.caseOfTheDay.specialty}
              </p>
              <p className="mt-1 text-[12px] text-text-tertiary">&ldquo;{data.caseOfTheDay.chiefComplaint}&rdquo;</p>
              <Link
                href={`/student/cases/${data.caseOfTheDay.id}`}
                className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-hairline-strong px-3.5 py-2 text-[12.5px] font-medium text-text-primary hover:border-cyan/40 hover:text-cyan"
              >
                Open case <ArrowRight size={13} />
              </Link>
            </Card>
          )}

          {data.emergencyChallenge && (
            <Card className="rounded-[20px] border-red/25 bg-red/[0.04]">
              <div className="flex items-center gap-2">
                <Siren size={15} className="text-red" />
                <CardLabel>Emergency challenge</CardLabel>
              </div>
              <p className="mt-2 text-[14px] font-medium">{data.emergencyChallenge.title}</p>
              <Link
                href={`/student/cases/${data.emergencyChallenge.id}`}
                className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-red px-3.5 py-2 text-[12.5px] font-medium text-white hover:brightness-110"
              >
                Enter Emergency Arena <ArrowRight size={13} />
              </Link>
            </Card>
          )}

          <Card className="rounded-[20px]">
            <CardLabel>Recommended cases</CardLabel>
            {data.weakestDomain && (
              <p className="mt-1.5 text-[12px] text-text-tertiary">
                Focus opportunity: <span className="text-text-secondary">{data.weakestDomain}</span>
              </p>
            )}
            <div className="mt-3 space-y-2">
              {data.recommended.length === 0 && <p className="text-[12.5px] text-text-tertiary">No new cases right now — check back soon.</p>}
              {data.recommended.map((c) => (
                <Link
                  key={c.id}
                  href={`/student/cases/${c.id}`}
                  className="flex items-center justify-between rounded-lg border border-hairline px-3.5 py-2.5 text-[13px] transition hover:border-cyan/30"
                >
                  <span>{c.title}</span>
                  <span className="text-[11px] text-text-tertiary">{c.specialty} · {c.difficulty}</span>
                </Link>
              ))}
            </div>
          </Card>

          <Card className="rounded-[20px]">
            <CardLabel>Recent scores</CardLabel>
            <div className="mt-3 space-y-2">
              {data.recentAttempts.length === 0 && <p className="text-[12.5px] text-text-tertiary">Complete your first case to see scores here.</p>}
              {data.recentAttempts.map((a) => (
                <div key={a.caseId + a.submittedAt} className="flex items-center justify-between rounded-lg border border-hairline px-3.5 py-2.5 text-[13px]">
                  <div>
                    <p>{a.title}</p>
                    <p className="text-[11px] text-text-tertiary">{a.specialty}</p>
                  </div>
                  <StatusPill label={a.passed ? `${a.score}% pass` : `${a.score}%`} tone={a.passed ? "emerald" : "amber"} className="rounded-md" />
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="rounded-[20px]">
            <CardLabel>Competency radar</CardLabel>
            {data.competencies.length === 0 ? (
              <p className="mt-3 text-[12.5px] text-text-tertiary">Complete cases to build your competency profile.</p>
            ) : (
              <div className="mt-2 h-[220px]">
                <ResponsiveContainer width="100%" height="100%">
                  <RadarChart data={data.competencies}>
                    <PolarGrid stroke="var(--hairline)" />
                    <PolarAngleAxis dataKey="domain" tick={{ fill: "var(--text-tertiary)", fontSize: 10 }} />
                    <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
                    <Radar dataKey="score" stroke="var(--cyan)" fill="var(--cyan)" fillOpacity={0.25} />
                  </RadarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          <Card className="rounded-[20px]">
            <div className="flex items-center gap-2">
              <BookOpen size={14} className="text-cyan" />
              <CardLabel>Achievements</CardLabel>
            </div>
            <div className="mt-3 space-y-2">
              {data.achievements.length === 0 && <p className="text-[12.5px] text-text-tertiary">No achievements yet — your first diagnosis unlocks one.</p>}
              {data.achievements.map((a) => (
                <div key={a.code} className="flex items-start gap-2.5">
                  <Trophy size={13} className="mt-0.5 shrink-0 text-amber" />
                  <div>
                    <p className="text-[12.5px] font-medium">{a.title}</p>
                    <p className="text-[11px] text-text-tertiary">{a.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card className="rounded-[20px]">
            <div className="flex items-center gap-2">
              <CalendarClock size={14} className="text-cyan" />
              <CardLabel>Weekly goal</CardLabel>
            </div>
            <p className="mt-2 text-[24px] font-semibold tabular-nums">{Math.min(data.totalCasesCompleted, 7)}/7</p>
            <p className="text-[11.5px] text-text-tertiary">cases this week</p>
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-black/[0.06]">
              <motion.div
                className="h-full rounded-full bg-cyan"
                initial={{ width: 0 }}
                animate={{ width: `${Math.min((data.totalCasesCompleted / 7) * 100, 100)}%` }}
                transition={{ duration: 0.6, ease: "easeOut" }}
              />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function StatTile({ icon: Icon, label, value, tone }: { icon: typeof Flame; label: string; value: string; tone: "amber" | "cyan" | "emerald" }) {
  const toneClass = tone === "amber" ? "text-amber" : tone === "emerald" ? "text-emerald" : "text-cyan";
  return (
    <Card className="rounded-lg">
      <Icon size={15} className={toneClass} />
      <p className="mt-2 text-[20px] font-semibold tabular-nums">{value}</p>
      <p className="text-[11px] text-text-tertiary">{label}</p>
    </Card>
  );
}

function LoadingSkeleton() {
  return (
    <div className="mx-auto max-w-6xl animate-pulse space-y-4">
      <div className="h-7 w-64 rounded bg-black/[0.05]" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-20 rounded-lg bg-black/[0.04]" />)}
      </div>
      <div className="h-40 rounded-[20px] bg-black/[0.04]" />
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <Card className="mx-auto max-w-lg rounded-[20px] text-center">
      <p className="text-[13.5px] text-text-secondary">{message}</p>
    </Card>
  );
}
