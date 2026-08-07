"use client";

import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardLabel } from "@/components/ui/Card";
import { capacityFor } from "@/store/useBedBookingStore";
import { useTranslation } from "@/hooks/useTranslation";
import { cn } from "@/lib/utils";
import type { BedCategory, HospitalAdmission, HospitalBedAvailability, HospitalDoctorEntry, HospitalStaffMember } from "@/types";

const STATUS_COLOR = { admitted: "#059669", critical: "#ef4444", discharged: "#6366f1" };
const STAFF_COLOR = { doctors: "#0891b2", staff: "#6366f1" };

function countFor(hospital: HospitalBedAvailability, category: BedCategory) {
  return category === "emergency" ? hospital.emergencyBeds : category === "icu" ? hospital.icuBeds : hospital.generalBeds;
}

function riskColorFor(pct: number) {
  return pct >= 90 ? "#dc2626" : pct >= 60 ? "#b45309" : "#15803d";
}

function ChartTooltip({ active, payload, label, suffix }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string; suffix?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-hairline-strong bg-card px-3 py-2 text-[11.5px] shadow-lg">
      <p className="font-medium text-text-primary">{label}</p>
      {payload.map((p) => (
        <p key={p.name} className="mt-0.5 flex items-center gap-1.5 text-text-secondary">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
          {p.name}: <span className="font-medium tabular-nums text-text-primary">{p.value}{suffix ?? ""}</span>
        </p>
      ))}
    </div>
  );
}

export function AnalyticsTab({
  hospital,
  doctors,
  staff,
  admissions,
}: {
  hospital: HospitalBedAvailability;
  doctors: HospitalDoctorEntry[];
  staff: HospitalStaffMember[];
  admissions: HospitalAdmission[];
}) {
  const { t } = useTranslation();
  const [showTable, setShowTable] = useState(false);

  const WARD_LABEL: Record<BedCategory, string> = {
    emergency: t("hospital.ward.emergency"),
    icu: t("hospital.ward.icu"),
    general: t("hospital.ward.general"),
  };

  const wardData = (["emergency", "icu", "general"] as BedCategory[]).map((w) => {
    const capacity = capacityFor(hospital, w);
    const free = countFor(hospital, w);
    const occupied = capacity - free;
    const pct = capacity > 0 ? Math.round((occupied / capacity) * 100) : 0;
    return { ward: WARD_LABEL[w], pct, occupied, capacity };
  });

  const statusData = useMemo(() => {
    const admitted = admissions.filter((a) => a.status === "admitted").length;
    const critical = admissions.filter((a) => a.status === "critical").length;
    const discharged = admissions.filter((a) => a.status === "discharged").length;
    return [
      { status: t("hospital.patients.admitted"), count: admitted, color: STATUS_COLOR.admitted },
      { status: t("hospital.patients.critical"), count: critical, color: STATUS_COLOR.critical },
      { status: t("hospital.patients.discharged"), count: discharged, color: STATUS_COLOR.discharged },
    ];
  }, [admissions, t]);

  const deptData = useMemo(() => {
    const names = Array.from(new Set([...doctors.map((d) => d.department), ...staff.map((s) => s.department)]));
    return names.map((name) => ({
      department: name,
      [t("hospital.departments.doctors")]: doctors.filter((d) => d.department === name && d.onDuty).length,
      [t("hospital.departments.staff")]: staff.filter((s) => s.department === name && s.onDuty).length,
    }));
  }, [doctors, staff, t]);

  const avgAge = useMemo(() => {
    if (admissions.length === 0) return 0;
    return Math.round(admissions.reduce((sum, a) => sum + a.age, 0) / admissions.length);
  }, [admissions]);

  const totalRevenuePotential = useMemo(
    () => doctors.reduce((sum, d) => sum + d.consultationFee, 0),
    [doctors]
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[14px] font-semibold text-text-primary">{t("hospital.analytics.title")}</p>
          <p className="text-[12px] text-text-secondary">{t("hospital.analytics.subtitle")}</p>
        </div>
        <button
          onClick={() => setShowTable((v) => !v)}
          className="rounded-full border border-hairline px-3.5 py-1.5 text-[11.5px] font-medium text-text-secondary transition hover:border-cyan/30 hover:text-cyan"
        >
          {showTable ? t("hospital.analytics.showCharts") : t("hospital.analytics.showTable")}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card>
          <CardLabel>{t("hospital.analytics.totalEverAdmitted")}</CardLabel>
          <p className="mt-2 text-[22px] font-semibold tabular-nums text-text-primary">{admissions.length}</p>
        </Card>
        <Card>
          <CardLabel>{t("hospital.analytics.avgPatientAge")}</CardLabel>
          <p className="mt-2 text-[22px] font-semibold tabular-nums text-text-primary">{avgAge}</p>
        </Card>
        <Card>
          <CardLabel>{t("hospital.analytics.activeDepartments")}</CardLabel>
          <p className="mt-2 text-[22px] font-semibold tabular-nums text-text-primary">{deptData.length}</p>
        </Card>
        <Card>
          <CardLabel>{t("hospital.analytics.consultationValue")}</CardLabel>
          <p className="mt-2 text-[22px] font-semibold tabular-nums text-text-primary">₹{totalRevenuePotential}</p>
        </Card>
      </div>

      {!showTable ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardLabel>{t("hospital.analytics.wardOccupancyTitle")}</CardLabel>
            <div className="mt-3 h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={wardData} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--hairline)" vertical={false} />
                  <XAxis dataKey="ward" tick={{ fontSize: 11, fill: "var(--text-tertiary)" }} axisLine={{ stroke: "var(--hairline)" }} tickLine={false} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: "var(--text-tertiary)" }} axisLine={false} tickLine={false} width={32} />
                  <Tooltip content={<ChartTooltip suffix="%" />} cursor={{ fill: "var(--hairline)" }} />
                  <Bar dataKey="pct" name={t("hospital.analytics.occupancyPct")} radius={[4, 4, 0, 0]} maxBarSize={48}>
                    {wardData.map((d) => (
                      <Cell key={d.ward} fill={riskColorFor(d.pct)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-[10.5px] text-text-tertiary">
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: "#15803d" }} /> {t("hospital.analytics.legendHealthy")}</span>
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: "#b45309" }} /> {t("hospital.analytics.legendBusy")}</span>
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: "#dc2626" }} /> {t("hospital.analytics.legendCritical")}</span>
            </div>
          </Card>

          <Card>
            <CardLabel>{t("hospital.analytics.statusBreakdownTitle")}</CardLabel>
            <div className="mt-3 h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={statusData} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--hairline)" vertical={false} />
                  <XAxis dataKey="status" tick={{ fontSize: 11, fill: "var(--text-tertiary)" }} axisLine={{ stroke: "var(--hairline)" }} tickLine={false} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "var(--text-tertiary)" }} axisLine={false} tickLine={false} width={24} />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--hairline)" }} />
                  <Bar dataKey="count" name={t("hospital.analytics.patientsLabel")} radius={[4, 4, 0, 0]} maxBarSize={48}>
                    {statusData.map((d) => (
                      <Cell key={d.status} fill={d.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <Card className="lg:col-span-2">
            <CardLabel>{t("hospital.analytics.staffingByDeptTitle")}</CardLabel>
            <div className="mt-3 h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={deptData} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--hairline)" vertical={false} />
                  <XAxis dataKey="department" tick={{ fontSize: 11, fill: "var(--text-tertiary)" }} axisLine={{ stroke: "var(--hairline)" }} tickLine={false} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "var(--text-tertiary)" }} axisLine={false} tickLine={false} width={24} />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--hairline)" }} />
                  <Legend wrapperStyle={{ fontSize: 11.5 }} iconType="circle" iconSize={8} />
                  <Bar dataKey={t("hospital.departments.doctors")} fill={STAFF_COLOR.doctors} radius={[4, 4, 0, 0]} maxBarSize={28} />
                  <Bar dataKey={t("hospital.departments.staff")} fill={STAFF_COLOR.staff} radius={[4, 4, 0, 0]} maxBarSize={28} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </div>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[520px] text-left text-[12px]">
            <thead>
              <tr className="border-b border-hairline text-[10.5px] uppercase tracking-[0.06em] text-text-tertiary">
                <th className="px-4 py-3 font-medium">{t("hospital.analytics.tableWard")}</th>
                <th className="px-4 py-3 font-medium">{t("hospital.analytics.tableOccupied")}</th>
                <th className="px-4 py-3 font-medium">{t("hospital.analytics.tableCapacity")}</th>
                <th className="px-4 py-3 font-medium">{t("hospital.analytics.occupancyPct")}</th>
              </tr>
            </thead>
            <tbody>
              {wardData.map((d) => (
                <tr key={d.ward} className="border-b border-hairline last:border-0">
                  <td className="px-4 py-2.5 text-text-primary">{d.ward}</td>
                  <td className="px-4 py-2.5 tabular-nums text-text-secondary">{d.occupied}</td>
                  <td className="px-4 py-2.5 tabular-nums text-text-secondary">{d.capacity}</td>
                  <td className={cn("px-4 py-2.5 tabular-nums font-medium")} style={{ color: riskColorFor(d.pct) }}>
                    {d.pct}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
