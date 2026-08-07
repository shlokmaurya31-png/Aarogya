"use client";

import { AlertTriangle, BedDouble, ChevronRight, Stethoscope, UserPlus, Users } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { capacityFor } from "@/store/useBedBookingStore";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/hooks/useTranslation";
import type { BedCategory, HospitalAdmission, HospitalBedAvailability, HospitalDoctorEntry, HospitalStaffMember } from "@/types";

type TabId = "overview" | "beds" | "patients" | "doctors" | "staff";

function countFor(hospital: HospitalBedAvailability, category: BedCategory) {
  return category === "emergency" ? hospital.emergencyBeds : category === "icu" ? hospital.icuBeds : hospital.generalBeds;
}

export function OverviewTab({
  hospital,
  doctors,
  staff,
  admissions,
  onNavigate,
}: {
  hospital: HospitalBedAvailability;
  doctors: HospitalDoctorEntry[];
  staff: HospitalStaffMember[];
  admissions: HospitalAdmission[];
  onNavigate: (tab: TabId) => void;
}) {
  const { t } = useTranslation();
  const CATEGORY_LABEL: Record<BedCategory, string> = {
    emergency: t("hospital.ward.emergency"),
    icu: t("hospital.ward.icu"),
    general: t("hospital.ward.general"),
  };
  const categories: BedCategory[] = ["emergency", "icu", "general"];
  const totalCapacity = categories.reduce((sum, c) => sum + capacityFor(hospital, c), 0);
  const totalFree = categories.reduce((sum, c) => sum + countFor(hospital, c), 0);
  const totalOccupied = totalCapacity - totalFree;
  const occupancyPct = totalCapacity > 0 ? Math.round((totalOccupied / totalCapacity) * 100) : 0;

  const activeAdmissions = admissions.filter((a) => a.status !== "discharged");
  const criticalAdmissions = admissions.filter((a) => a.status === "critical");
  const doctorsOnDuty = doctors.filter((d) => d.onDuty).length;
  const staffOnDuty = staff.filter((m) => m.onDuty).length;

  const kpiCardClass = cn(
    "rounded-[20px] border border-hairline bg-card p-5 text-left transition",
    "hover:border-cyan/30 hover:shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_24px_-12px_rgba(14,116,144,0.25)]"
  );

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <button onClick={() => onNavigate("beds")} className={kpiCardClass}>
          <CardLabel>{t("hospital.overview.bedOccupancy")}</CardLabel>
          <p className="mt-2 text-[26px] font-semibold tabular-nums text-text-primary">{occupancyPct}%</p>
          <p className="mt-0.5 text-[11px] text-text-tertiary">
            {totalOccupied} {t("hospital.overview.of")} {totalCapacity} {t("hospital.overview.bedsInUse")}
          </p>
        </button>
        <button onClick={() => onNavigate("patients")} className={kpiCardClass}>
          <CardLabel>{t("hospital.overview.admittedPatients")}</CardLabel>
          <p className="mt-2 text-[26px] font-semibold tabular-nums text-text-primary">{activeAdmissions.length}</p>
          <p className="mt-0.5 text-[11px] text-red">
            {criticalAdmissions.length} {t("hospital.overview.critical")}
          </p>
        </button>
        <button onClick={() => onNavigate("doctors")} className={kpiCardClass}>
          <CardLabel>{t("hospital.overview.doctorsOnDuty")}</CardLabel>
          <p className="mt-2 text-[26px] font-semibold tabular-nums text-text-primary">
            {doctorsOnDuty}
            <span className="text-[15px] font-normal text-text-tertiary">/{doctors.length}</span>
          </p>
          <p className="mt-0.5 text-[11px] text-text-tertiary">{t("hospital.overview.onRoster")}</p>
        </button>
        <button onClick={() => onNavigate("staff")} className={kpiCardClass}>
          <CardLabel>{t("hospital.overview.staffOnDuty")}</CardLabel>
          <p className="mt-2 text-[26px] font-semibold tabular-nums text-text-primary">
            {staffOnDuty}
            <span className="text-[15px] font-normal text-text-tertiary">/{staff.length}</span>
          </p>
          <p className="mt-0.5 text-[11px] text-text-tertiary">{t("hospital.overview.nursesSupport")}</p>
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <button onClick={() => onNavigate("beds")} className={kpiCardClass}>
          <div className="flex items-center justify-between">
            <CardLabel>{t("hospital.overview.bedsByWard")}</CardLabel>
            <ChevronRight size={14} className="text-text-tertiary" />
          </div>
          <div className="mt-3 space-y-3">
            {categories.map((cat) => {
              const free = countFor(hospital, cat);
              const capacity = capacityFor(hospital, cat);
              const occupied = capacity - free;
              const pct = capacity > 0 ? Math.round((occupied / capacity) * 100) : 0;
              return (
                <div key={cat}>
                  <div className="flex items-center justify-between text-[12px]">
                    <span className="flex items-center gap-1.5 font-medium text-text-primary">
                      <BedDouble size={13} className="text-cyan" /> {CATEGORY_LABEL[cat]}
                    </span>
                    <span className="tabular-nums text-text-tertiary">
                      {occupied}/{capacity} {t("hospital.overview.occupied")}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-black/[0.07]">
                    <div
                      style={{ width: `${pct}%` }}
                      className={`h-full rounded-full ${pct >= 90 ? "bg-red" : pct >= 60 ? "bg-amber" : "bg-emerald"}`}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </button>

        <Card>
          <div className="flex items-center justify-between">
            <CardLabel>{t("hospital.overview.criticalPatients")}</CardLabel>
            {criticalAdmissions.length > 0 && <AlertTriangle size={14} className="text-red" />}
          </div>
          <div className="mt-3 space-y-2.5">
            {criticalAdmissions.length === 0 && (
              <p className="py-4 text-center text-[12.5px] text-text-tertiary">{t("hospital.overview.noCriticalPatients")}</p>
            )}
            {criticalAdmissions.map((a) => (
              <button
                key={a.id}
                onClick={() => onNavigate("patients")}
                className="block w-full rounded-2xl border border-red/20 bg-red/[0.04] px-3.5 py-2.5 text-left transition hover:border-red/35 hover:bg-red/[0.07]"
              >
                <p className="text-[12.5px] font-medium text-text-primary">
                  {a.patientName} <span className="font-normal text-text-tertiary">· {CATEGORY_LABEL[a.ward]} {a.bedLabel}</span>
                </p>
                <p className="mt-0.5 text-[11px] text-text-tertiary">
                  {a.diagnosis} · {t("hospital.overview.under")} {a.doctorName}
                </p>
              </button>
            ))}
          </div>
        </Card>
      </div>

      <Card className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-cyan/10 text-cyan">
            <Stethoscope size={18} />
          </span>
          <div>
            <p className="text-[13.5px] font-medium text-text-primary">{t("hospital.overview.quickActions")}</p>
            <p className="text-[12px] text-text-secondary">{t("hospital.overview.quickActionsSubtitle")}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => onNavigate("patients")}
            className="flex items-center gap-1.5 rounded-full bg-cyan px-3.5 py-2 text-[12px] font-medium text-ink transition hover:brightness-110 active:scale-[0.97]"
          >
            <UserPlus size={13} /> {t("hospital.overview.admitPatient")}
          </button>
          <button
            onClick={() => onNavigate("doctors")}
            className="flex items-center gap-1.5 rounded-full border border-hairline px-3.5 py-2 text-[12px] font-medium text-text-secondary transition hover:border-cyan/30 hover:text-cyan"
          >
            <Stethoscope size={13} /> {t("hospital.overview.doctorsLabel")}
          </button>
          <button
            onClick={() => onNavigate("staff")}
            className="flex items-center gap-1.5 rounded-full border border-hairline px-3.5 py-2 text-[12px] font-medium text-text-secondary transition hover:border-cyan/30 hover:text-cyan"
          >
            <Users size={13} /> {t("hospital.overview.staffLabel")}
          </button>
        </div>
      </Card>
    </div>
  );
}
