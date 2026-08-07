"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, Building2, Stethoscope, Users } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { useTranslation } from "@/hooks/useTranslation";
import type { HospitalAdmission, HospitalDoctorEntry, HospitalStaffMember } from "@/types";

interface DepartmentSummary {
  name: string;
  doctors: HospitalDoctorEntry[];
  staff: HospitalStaffMember[];
  activePatients: HospitalAdmission[];
  criticalPatients: HospitalAdmission[];
}

export function DepartmentsTab({
  doctors,
  staff,
  admissions,
}: {
  doctors: HospitalDoctorEntry[];
  staff: HospitalStaffMember[];
  admissions: HospitalAdmission[];
}) {
  const { t } = useTranslation();

  const departments = useMemo<DepartmentSummary[]>(() => {
    const names = Array.from(new Set([...doctors.map((d) => d.department), ...staff.map((s) => s.department)]));
    return names
      .map((name) => {
        const deptDoctors = doctors.filter((d) => d.department === name);
        const deptStaff = staff.filter((s) => s.department === name);
        const doctorIds = new Set(deptDoctors.map((d) => d.id));
        const active = admissions.filter((a) => a.status !== "discharged" && doctorIds.has(a.doctorId));
        return {
          name,
          doctors: deptDoctors,
          staff: deptStaff,
          activePatients: active,
          criticalPatients: active.filter((a) => a.status === "critical"),
        };
      })
      .sort((a, b) => b.doctors.length + b.staff.length - (a.doctors.length + a.staff.length));
  }, [doctors, staff, admissions]);

  const avgExperience = (dept: DepartmentSummary) =>
    dept.doctors.length === 0
      ? 0
      : Math.round((dept.doctors.reduce((sum, d) => sum + d.yearsExperience, 0) / dept.doctors.length) * 10) / 10;

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[14px] font-semibold text-text-primary">{t("hospital.departments.title")}</p>
        <p className="text-[12px] text-text-secondary">
          {departments.length} {t("hospital.departments.subtitle")}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {departments.map((dept, i) => {
          const doctorsOnDuty = dept.doctors.filter((d) => d.onDuty).length;
          const staffOnDuty = dept.staff.filter((s) => s.onDuty).length;
          return (
            <motion.div
              key={dept.name}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: i * 0.04 }}
            >
              <Card>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-cyan/10 text-cyan">
                      <Building2 size={17} />
                    </span>
                    <div>
                      <p className="text-[13.5px] font-medium text-text-primary">{dept.name}</p>
                      <p className="text-[11.5px] text-text-tertiary">
                        {dept.doctors.length > 0
                          ? `${avgExperience(dept)} ${t("hospital.departments.avgExperience")}`
                          : t("hospital.departments.supportUnit")}
                      </p>
                    </div>
                  </div>
                  {dept.criticalPatients.length > 0 && (
                    <span className="flex items-center gap-1 rounded-full border border-red/25 bg-red/[0.06] px-2.5 py-1 text-[10.5px] font-medium text-red">
                      <AlertTriangle size={11} /> {dept.criticalPatients.length} {t("hospital.departments.critical")}
                    </span>
                  )}
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2">
                  <div className="rounded-xl border border-hairline px-3 py-2 text-center">
                    <p className="flex items-center justify-center gap-1 text-[10px] uppercase tracking-[0.06em] text-text-tertiary">
                      <Stethoscope size={10} /> {t("hospital.departments.doctors")}
                    </p>
                    <p className="mt-1 text-[15px] font-semibold tabular-nums text-text-primary">
                      {doctorsOnDuty}<span className="text-[11px] font-normal text-text-tertiary">/{dept.doctors.length}</span>
                    </p>
                  </div>
                  <div className="rounded-xl border border-hairline px-3 py-2 text-center">
                    <p className="flex items-center justify-center gap-1 text-[10px] uppercase tracking-[0.06em] text-text-tertiary">
                      <Users size={10} /> {t("hospital.departments.staff")}
                    </p>
                    <p className="mt-1 text-[15px] font-semibold tabular-nums text-text-primary">
                      {staffOnDuty}<span className="text-[11px] font-normal text-text-tertiary">/{dept.staff.length}</span>
                    </p>
                  </div>
                  <div className="rounded-xl border border-hairline px-3 py-2 text-center">
                    <p className="text-[10px] uppercase tracking-[0.06em] text-text-tertiary">{t("hospital.departments.patients")}</p>
                    <p className="mt-1 text-[15px] font-semibold tabular-nums text-text-primary">{dept.activePatients.length}</p>
                  </div>
                </div>

                {dept.doctors.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {dept.doctors.map((d) => (
                      <span
                        key={d.id}
                        className="rounded-full border border-hairline px-2.5 py-1 text-[10.5px] text-text-secondary"
                      >
                        {d.name}
                      </span>
                    ))}
                  </div>
                )}
              </Card>
            </motion.div>
          );
        })}
        {departments.length === 0 && (
          <Card className="col-span-full flex flex-col items-center gap-2 py-8 text-center">
            <CardLabel>{t("hospital.departments.emptyState")}</CardLabel>
          </Card>
        )}
      </div>
    </div>
  );
}
