"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Building2, LogOut, Settings } from "lucide-react";
import { StatusPill } from "@/components/ui/StatusPill";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { PillToggle } from "@/components/auth/PillToggle";
import { OverviewTab } from "@/components/hospital/OverviewTab";
import { BedsTab } from "@/components/hospital/BedsTab";
import { PatientsTab } from "@/components/hospital/PatientsTab";
import { DoctorsTab } from "@/components/hospital/DoctorsTab";
import { StaffTab } from "@/components/hospital/StaffTab";
import { DepartmentsTab } from "@/components/hospital/DepartmentsTab";
import { AnalyticsTab } from "@/components/hospital/AnalyticsTab";
import { useTranslation } from "@/hooks/useTranslation";
import { useAuthStore } from "@/store/useAuthStore";
import { useBedBookingStore } from "@/store/useBedBookingStore";
import { useHospitalOpsStore } from "@/store/useHospitalOpsStore";
import type { BedCategory } from "@/types";

const STARTER_BEDS = {
  emergencyBeds: 5,
  icuBeds: 2,
  generalBeds: 10,
  emergencyCapacity: 7,
  icuCapacity: 4,
  generalCapacity: 13,
};

type TabId = "overview" | "beds" | "patients" | "doctors" | "staff" | "departments" | "analytics";

const TAB_IDS: TabId[] = ["overview", "beds", "patients", "doctors", "staff", "departments", "analytics"];

export default function HospitalPage() {
  const router = useRouter();
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const hasHydrated = useAuthStore((s) => s.hasHydrated);
  const logout = useAuthStore((s) => s.logout);

  const hospitals = useBedBookingStore((s) => s.hospitals);
  const activeBooking = useBedBookingStore((s) => s.activeBooking);
  const registerHospital = useBedBookingStore((s) => s.registerHospital);

  const doctorsByHospital = useHospitalOpsStore((s) => s.doctorsByHospital);
  const staffByHospital = useHospitalOpsStore((s) => s.staffByHospital);
  const admissionsByHospital = useHospitalOpsStore((s) => s.admissionsByHospital);
  const ensureSeeded = useHospitalOpsStore((s) => s.ensureSeeded);

  const [tab, setTab] = useState<TabId>("overview");
  const [quickAdmit, setQuickAdmit] = useState<{ ward: BedCategory; token: number } | null>(null);

  const TAB_LABEL_KEYS: Record<TabId, string> = {
    overview: "hospital.tab.overview",
    beds: "hospital.tab.beds",
    patients: "hospital.tab.patients",
    doctors: "hospital.tab.doctors",
    staff: "hospital.tab.staff",
    departments: "hospital.tab.departments",
    analytics: "hospital.tab.analytics",
  };
  const TAB_OPTIONS: { id: TabId; label: string }[] = TAB_IDS.map((id) => ({
    id,
    label: t(TAB_LABEL_KEYS[id]),
  }));

  function handleQuickAdmit(ward: BedCategory) {
    setQuickAdmit({ ward, token: Date.now() });
    setTab("patients");
  }

  useEffect(() => {
    if (!hasHydrated) return;
    if (!user || user.role !== "hospital") router.replace("/login");
  }, [hasHydrated, user, router]);

  const myHospitalId = useMemo(() => (user ? `hosp-${user.id}` : ""), [user]);

  useEffect(() => {
    if (!user || user.role !== "hospital") return;
    if (!hospitals.some((h) => h.id === myHospitalId)) {
      registerHospital({
        id: myHospitalId,
        name: user.name,
        city: user.city ?? "Not set",
        distanceKm: 0,
        avgWaitMinutes: 20,
        ...STARTER_BEDS,
      });
    }
    ensureSeeded(myHospitalId);
  }, [user, hospitals, myHospitalId, registerHospital, ensureSeeded]);

  const myHospital = hospitals.find((h) => h.id === myHospitalId);
  const doctors = doctorsByHospital[myHospitalId] ?? [];
  const staff = staffByHospital[myHospitalId] ?? [];
  const admissions = admissionsByHospital[myHospitalId] ?? [];

  if (!hasHydrated || !user || user.role !== "hospital" || !myHospital) {
    return <div className="flex min-h-screen items-center justify-center bg-ink text-text-tertiary">{t("common.loading")}</div>;
  }

  return (
    <div className="min-h-screen bg-ink text-text-primary">
      <header className="sticky top-0 z-40 border-b border-hairline bg-ink/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between px-5 py-3.5">
          <div className="flex items-center gap-2.5 text-[13.5px] font-semibold">
            <Building2 size={16} className="text-cyan" />
            {user.name}
            {user.verificationStatus === "pending" && <StatusPill label={t("common.verificationPending")} tone="amber" />}
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/settings"
              className="flex items-center gap-1.5 rounded-full border border-hairline px-3.5 py-1.5 text-[12px] text-text-secondary transition hover:border-cyan/30 hover:text-cyan"
            >
              <Settings size={13} /> {t("common.settings")}
            </Link>
            <button
              onClick={() => {
                logout();
                router.push("/");
              }}
              className="flex items-center gap-1.5 rounded-full border border-hairline px-3.5 py-1.5 text-[12px] text-text-secondary transition hover:border-red/30 hover:text-red"
            >
              <LogOut size={13} /> {t("common.logout")}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1200px] px-5 py-8">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[20px] font-semibold tracking-tight text-text-primary">{myHospital.name}</p>
            <p className="text-[12.5px] text-text-secondary">{myHospital.city} · {t("hospital.subtitle")}</p>
          </div>
          <PillToggle groupId="hospital-tab" options={TAB_OPTIONS} value={tab} onChange={setTab} />
        </div>

        {tab === "overview" && (
          <OverviewTab hospital={myHospital} doctors={doctors} staff={staff} admissions={admissions} onNavigate={setTab} />
        )}
        {tab === "beds" && (
          <BedsTab hospital={myHospital} admissions={admissions} activeBooking={activeBooking} onQuickAdmit={handleQuickAdmit} />
        )}
        {tab === "patients" && (
          <PatientsTab
            hospitalId={myHospitalId}
            hospital={myHospital}
            admissions={admissions}
            doctors={doctors}
            quickAdmit={quickAdmit}
          />
        )}
        {tab === "doctors" && <DoctorsTab hospitalId={myHospitalId} doctors={doctors} admissions={admissions} />}
        {tab === "staff" && <StaffTab hospitalId={myHospitalId} staff={staff} />}
        {tab === "departments" && <DepartmentsTab doctors={doctors} staff={staff} admissions={admissions} />}
        {tab === "analytics" && (
          <AnalyticsTab hospital={myHospital} doctors={doctors} staff={staff} admissions={admissions} />
        )}
      </main>
      <ToastViewport />
    </div>
  );
}
