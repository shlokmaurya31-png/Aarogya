"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { DashboardHero } from "@/components/admin/DashboardHero";
import { useAuthStore } from "@/store/useAuthStore";
import { useTranslation } from "@/hooks/useTranslation";
import type { VerificationApplication } from "@/types";

const STATUS_TONE: Record<VerificationApplication["status"], "amber" | "emerald" | "red"> = {
  pending: "amber",
  verified: "emerald",
  rejected: "red",
};

const STATUS_COLOR: Record<VerificationApplication["status"], string> = {
  pending: "#b45309",
  verified: "#15803d",
  rejected: "#dc2626",
};

const ROLE_COLOR: Record<VerificationApplication["role"], string> = {
  doctor: "#0e7490",
  lab: "#6366f1",
  hospital: "#0891b2",
};

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-hairline-strong bg-card px-3 py-2 text-[11.5px] shadow-lg">
      <p className="font-medium text-text-primary">{label}</p>
      {payload.map((p) => (
        <p key={p.name} className="mt-0.5 flex items-center gap-1.5 text-text-secondary">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
          {p.name}: <span className="font-medium tabular-nums text-text-primary">{p.value}</span>
        </p>
      ))}
    </div>
  );
}

export default function AdminOverviewPage() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const verificationApplications = useAuthStore((s) => s.verificationApplications);

  const pendingCount = verificationApplications.filter((a) => a.status === "pending").length;
  const verifiedCount = verificationApplications.filter((a) => a.status === "verified").length;
  const rejectedCount = verificationApplications.filter((a) => a.status === "rejected").length;
  const doctorCount = verificationApplications.filter((a) => a.role === "doctor").length;
  const labCount = verificationApplications.filter((a) => a.role === "lab").length;
  const hospitalCount = verificationApplications.filter((a) => a.role === "hospital").length;

  const roleData = useMemo(
    () => [
      { role: t("admin.role.doctor"), count: doctorCount, color: ROLE_COLOR.doctor },
      { role: t("admin.role.lab"), count: labCount, color: ROLE_COLOR.lab },
      { role: t("admin.role.hospital"), count: hospitalCount, color: ROLE_COLOR.hospital },
    ],
    [doctorCount, labCount, hospitalCount, t]
  );

  const statusData = useMemo(
    () => [
      { status: t("admin.status.pending"), count: pendingCount, color: STATUS_COLOR.pending },
      { status: t("admin.status.verified"), count: verifiedCount, color: STATUS_COLOR.verified },
      { status: t("admin.status.rejected"), count: rejectedCount, color: STATUS_COLOR.rejected },
    ],
    [pendingCount, verifiedCount, rejectedCount, t]
  );

  const timelineData = useMemo(() => {
    const byDate = new Map<string, number>();
    for (const app of verificationApplications) {
      byDate.set(app.submittedAt, (byDate.get(app.submittedAt) ?? 0) + 1);
    }
    return Array.from(byDate.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date: date.slice(5), count }));
  }, [verificationApplications]);

  const recent = useMemo(
    () => [...verificationApplications].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)).slice(0, 5),
    [verificationApplications]
  );

  if (!user) return null;

  return (
    <div>
      <DashboardHero user={user} pendingCount={pendingCount} />

      <div className="mt-8">
        <h1 className="text-[20px] font-semibold tracking-tight text-text-primary">{t("admin.overview.title")}</h1>
        <p className="mt-1 text-[12.5px] text-text-secondary">{t("admin.overview.subtitle")}</p>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card className="rounded-lg">
          <CardLabel>{t("admin.stat.pendingVerification")}</CardLabel>
          <p className="mt-2 text-[26px] font-semibold tabular-nums">{pendingCount}</p>
        </Card>
        <Card className="rounded-lg">
          <CardLabel>{t("admin.stat.verified")}</CardLabel>
          <p className="mt-2 text-[26px] font-semibold tabular-nums">{verifiedCount}</p>
        </Card>
        <Card className="rounded-lg">
          <CardLabel>{t("admin.stat.rejected")}</CardLabel>
          <p className="mt-2 text-[26px] font-semibold tabular-nums">{rejectedCount}</p>
        </Card>
        <Card className="rounded-lg">
          <CardLabel>{t("admin.stat.totalApplications")}</CardLabel>
          <p className="mt-2 text-[26px] font-semibold tabular-nums">{verificationApplications.length}</p>
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="rounded-lg">
          <CardLabel>{t("admin.overview.roleBreakdownTitle")}</CardLabel>
          <div className="mt-3 h-52">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={roleData} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--hairline)" vertical={false} />
                <XAxis dataKey="role" tick={{ fontSize: 11, fill: "var(--text-tertiary)" }} axisLine={{ stroke: "var(--hairline)" }} tickLine={false} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "var(--text-tertiary)" }} axisLine={false} tickLine={false} width={24} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--hairline)" }} />
                <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={48}>
                  {roleData.map((d) => (
                    <Cell key={d.role} fill={d.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="rounded-lg">
          <CardLabel>{t("admin.overview.statusBreakdownTitle")}</CardLabel>
          <div className="mt-3 h-52">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={statusData} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--hairline)" vertical={false} />
                <XAxis dataKey="status" tick={{ fontSize: 11, fill: "var(--text-tertiary)" }} axisLine={{ stroke: "var(--hairline)" }} tickLine={false} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "var(--text-tertiary)" }} axisLine={false} tickLine={false} width={24} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--hairline)" }} />
                <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={48}>
                  {statusData.map((d) => (
                    <Cell key={d.status} fill={d.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="rounded-lg lg:col-span-2">
          <CardLabel>{t("admin.overview.submissionsOverTimeTitle")}</CardLabel>
          <div className="mt-3 h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={timelineData} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--hairline)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: "var(--text-tertiary)" }} axisLine={{ stroke: "var(--hairline)" }} tickLine={false} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "var(--text-tertiary)" }} axisLine={false} tickLine={false} width={24} />
                <Tooltip content={<ChartTooltip />} cursor={{ stroke: "var(--hairline)" }} />
                <Line type="monotone" dataKey="count" stroke="#0e7490" strokeWidth={2} dot={{ r: 3, fill: "#0e7490" }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <div className="mt-6 flex items-center justify-between">
        <h2 className="text-[15px] font-medium">{t("admin.overview.recentActivityTitle")}</h2>
        <Link href="/admin/verifications" className="text-[12px] font-medium text-cyan hover:underline">
          {t("admin.overview.viewAll")}
        </Link>
      </div>
      <div className="mt-3 space-y-2.5">
        {recent.map((app) => (
          <Card key={app.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg py-3.5">
            <div>
              <p className="text-[13px] font-medium">{app.name}</p>
              <p className="mt-0.5 text-[11.5px] text-text-tertiary">
                {app.facility} · {t("admin.label.submitted")} {app.submittedAt}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <StatusPill label={t(`admin.role.${app.role}`)} tone="cyan" className="rounded-md" />
              <StatusPill label={t(`admin.status.${app.status}`)} tone={STATUS_TONE[app.status]} className="rounded-md" />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
