"use client";

import { useEffect, useState } from "react";
import { Card, CardLabel } from "@/components/ui/Card";
import {
  RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, Tooltip, LineChart, Line, CartesianGrid,
} from "recharts";

interface ProgressData {
  competencyRadar: { domain: string; score: number }[];
  specialtyPerformance: { specialty: string; averageScore: number; count: number }[];
  difficultyPerformance: { difficulty: string; averageScore: number; count: number }[];
  averageSafetyScore: number | null;
  averagePrescriptionScore: number | null;
  weeklyTrend: { date: string; score: number; title: string }[];
  totalCompleted: number;
  strongestDomain: { domain: string; score: number } | null;
  weakestDomain: { domain: string; score: number } | null;
}

export function StudentProgress() {
  const [data, setData] = useState<ProgressData | null>(null);

  useEffect(() => {
    fetch("/api/student/progress").then((r) => r.json()).then(setData);
  }, []);

  if (!data) return <div className="mx-auto max-w-5xl animate-pulse space-y-4"><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;

  if (data.totalCompleted === 0) {
    return (
      <div className="mx-auto max-w-2xl text-center">
        <h1 className="text-[20px] font-semibold tracking-tight">Progress Intelligence</h1>
        <Card className="mt-6 rounded-[20px]">
          <p className="text-[13.5px] text-text-secondary">Complete your first case to start building your competency profile.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-[20px] font-semibold tracking-tight">Progress Intelligence</h1>
      <p className="mt-1 text-[13px] text-text-secondary">{data.totalCompleted} cases completed.</p>

      {(data.strongestDomain || data.weakestDomain) && (
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {data.strongestDomain && (
            <Card className="rounded-lg border-emerald/25 bg-emerald/[0.04]">
              <p className="text-[12px] text-text-tertiary">Your strongest domain is...</p>
              <p className="mt-1 text-[15px] font-medium text-emerald">{data.strongestDomain.domain} ({data.strongestDomain.score}%)</p>
            </Card>
          )}
          {data.weakestDomain && (
            <Card className="rounded-lg border-amber/25 bg-amber/[0.04]">
              <p className="text-[12px] text-text-tertiary">Your greatest improvement opportunity is...</p>
              <p className="mt-1 text-[15px] font-medium text-amber">{data.weakestDomain.domain} ({data.weakestDomain.score}%)</p>
            </Card>
          )}
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="rounded-[20px]">
          <CardLabel>Competency radar</CardLabel>
          <div className="mt-2 h-[240px]">
            <ResponsiveContainer width="100%" height="100%">
              <RadarChart data={data.competencyRadar}>
                <PolarGrid stroke="var(--hairline)" />
                <PolarAngleAxis dataKey="domain" tick={{ fill: "var(--text-tertiary)", fontSize: 10 }} />
                <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
                <Radar dataKey="score" stroke="var(--cyan)" fill="var(--cyan)" fillOpacity={0.25} />
              </RadarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="rounded-[20px]">
          <CardLabel>Specialty performance</CardLabel>
          <div className="mt-2 h-[240px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.specialtyPerformance} layout="vertical" margin={{ left: 16 }}>
                <XAxis type="number" domain={[0, 100]} tick={{ fill: "var(--text-tertiary)", fontSize: 10 }} />
                <YAxis type="category" dataKey="specialty" width={110} tick={{ fill: "var(--text-tertiary)", fontSize: 10 }} />
                <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--hairline)", fontSize: 12 }} />
                <Bar dataKey="averageScore" fill="var(--cyan)" radius={4} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="rounded-[20px]">
          <CardLabel>Performance by difficulty</CardLabel>
          <div className="mt-2 h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.difficultyPerformance}>
                <XAxis dataKey="difficulty" tick={{ fill: "var(--text-tertiary)", fontSize: 9 }} />
                <YAxis domain={[0, 100]} tick={{ fill: "var(--text-tertiary)", fontSize: 10 }} />
                <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--hairline)", fontSize: 12 }} />
                <Bar dataKey="averageScore" fill="var(--emerald)" radius={4} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="rounded-[20px]">
          <CardLabel>Recent case trend</CardLabel>
          <div className="mt-2 h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.weeklyTrend}>
                <CartesianGrid stroke="var(--hairline)" strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fill: "var(--text-tertiary)", fontSize: 9 }} />
                <YAxis domain={[0, 100]} tick={{ fill: "var(--text-tertiary)", fontSize: 10 }} />
                <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--hairline)", fontSize: 12 }} />
                <Line type="monotone" dataKey="score" stroke="var(--cyan)" strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Card className="rounded-lg">
          <CardLabel>Average safety score</CardLabel>
          <p className="mt-1.5 text-[22px] font-semibold tabular-nums">{data.averageSafetyScore ?? "—"}%</p>
        </Card>
        <Card className="rounded-lg">
          <CardLabel>Average prescription score</CardLabel>
          <p className="mt-1.5 text-[22px] font-semibold tabular-nums">{data.averagePrescriptionScore ?? "—"}%</p>
        </Card>
      </div>
    </div>
  );
}
