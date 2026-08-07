"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import { BadgeCheck, FlaskConical, LogOut, Settings, UploadCloud } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { FileDropField } from "@/components/auth/FileDropField";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { useAuthStore } from "@/store/useAuthStore";
import { useRecordsStore } from "@/store/useRecordsStore";
import { useToastStore } from "@/store/useToastStore";
import { useTranslation } from "@/hooks/useTranslation";
import { LAB_REPORT_CATEGORIES, LAB_CATEGORY_MAP } from "@/lib/lab-categories";
import { patient } from "@/lib/mock-data";
import type { LabReportCategory } from "@/types";

const inputClass =
  "w-full rounded-xl border border-hairline bg-black/[0.02] px-3.5 py-2.5 text-[13.5px] outline-none transition placeholder:text-text-tertiary focus:border-cyan/40 focus:bg-cyan/[0.03]";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12.5px] font-medium text-text-secondary">{label}</span>
      {children}
    </label>
  );
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

export default function LabPage() {
  const router = useRouter();
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const hasHydrated = useAuthStore((s) => s.hasHydrated);
  const logout = useAuthStore((s) => s.logout);
  const reports = useRecordsStore((s) => s.reports);
  const addReport = useRecordsStore((s) => s.addReport);
  const addNotification = useRecordsStore((s) => s.addNotification);
  const push = useToastStore((s) => s.push);

  const [patientRef, setPatientRef] = useState(patient.patientId);
  const [category, setCategory] = useState<LabReportCategory>("routine-blood-panel");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasHydrated) return;
    if (!user || user.role !== "lab") router.replace("/login");
  }, [hasHydrated, user, router]);

  const categoryDef = LAB_CATEGORY_MAP[category];

  const myReports = useMemo(
    () => reports.filter((r) => user && r.facility === (user.facility ?? user.name)),
    [reports, user]
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    if (!file) {
      setFileError(t("lab.error.attachFile"));
      return;
    }
    if (!patientRef.trim()) {
      push(t("lab.error.enterPatientId"), "amber");
      return;
    }

    const reportTitle = title.trim() || categoryDef.label;
    const facility = user.facility ?? user.name;

    addReport({
      id: `lab-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title: reportTitle,
      kind: "lab",
      facility,
      date: new Date().toISOString().slice(0, 10),
      sizeKb: Math.max(1, Math.round(file.size / 1024)),
      verified: true,
      labCategory: category,
      patientRef: patientRef.trim(),
    });
    addNotification({
      id: `note-lab-${Date.now()}`,
      kind: "lab",
      title: `${t("lab.notification.newResultPrefix")} ${categoryDef.label} ${t("lab.notification.newResultSuffix")}`,
      // Left as-is: three interpolated values (title, facility, patient ID) make
      // fragment-level translation unreliable across languages with different word order.
      detail: `${reportTitle}, uploaded by ${facility} for ${patientRef.trim()}`,
      time: t("lab.time.justNow"),
      risk: "watch",
    });

    push(`${reportTitle} ${t("lab.toast.registeredFor")} ${patientRef.trim()}.`, "emerald");
    setTitle("");
    setFile(null);
    setFileError(null);
  }

  if (!hasHydrated || !user || user.role !== "lab") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-ink text-text-tertiary">
        {t("lab.loading")}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-ink text-text-primary">
      <header className="sticky top-0 z-40 border-b border-hairline bg-ink/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between px-5 py-3.5">
          <div className="flex items-center gap-2.5 text-[13.5px] font-semibold">
            <FlaskConical size={16} className="text-cyan" />
            {user.name}
            {user.verificationStatus === "pending" && (
              <StatusPill label={t("lab.header.verificationPending")} tone="amber" />
            )}
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/settings"
              className="flex items-center gap-1.5 rounded-full border border-hairline px-3.5 py-1.5 text-[12px] text-text-secondary transition hover:border-cyan/30 hover:text-cyan"
            >
              <Settings size={13} /> {t("lab.header.settings")}
            </Link>
            <button
              onClick={() => {
                logout();
                router.push("/");
              }}
              className="flex items-center gap-1.5 rounded-full border border-hairline px-3.5 py-1.5 text-[12px] text-text-secondary transition hover:border-red/30 hover:text-red"
            >
              <LogOut size={13} /> {t("lab.header.logout")}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1200px] px-5 py-8">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[400px_1fr]">
          <Card>
            <CardLabel>{t("lab.card.registerReport")}</CardLabel>
            <form onSubmit={handleSubmit} className="mt-4 space-y-4">
              <Field label={t("lab.field.patientId")}>
                <input
                  value={patientRef}
                  onChange={(e) => setPatientRef(e.target.value)}
                  required
                  className={inputClass}
                  placeholder={t("lab.field.patientIdPlaceholder")}
                />
              </Field>

              <Field label={t("lab.field.reportCategory")}>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as LabReportCategory)}
                  className={inputClass}
                >
                  {LAB_REPORT_CATEGORIES.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1.5 text-[11px] text-text-tertiary">
                  {t("lab.field.categoryIncludes")}: {categoryDef.examples.join(", ")}
                </p>
              </Field>

              <Field label={t("lab.field.reportTitle")}>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className={inputClass}
                  placeholder={categoryDef.label}
                />
              </Field>

              <FileDropField
                label={t("lab.field.reportFile")}
                hint={t("lab.field.reportFileHint")}
                accept="image/*,.pdf"
                file={file}
                onChange={(f) => {
                  setFile(f);
                  setFileError(null);
                }}
                error={fileError ?? undefined}
              />

              <button
                type="submit"
                className="flex w-full items-center justify-center gap-2 rounded-full bg-cyan py-3 text-[13.5px] font-medium text-ink transition hover:brightness-110 active:scale-[0.99]"
              >
                <UploadCloud size={15} /> {t("lab.action.register")}
              </button>
            </form>
          </Card>

          <Card>
            <CardLabel>
              {t("lab.card.reportsRegisteredBy")} {user.name}
            </CardLabel>
            <div className="mt-4 space-y-3">
              {myReports.length === 0 && (
                <p className="py-8 text-center text-[13px] text-text-tertiary">
                  {t("lab.empty.noReports")}
                </p>
              )}
              {myReports.map((r, i) => (
                <motion.div
                  key={r.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, delay: i * 0.03 }}
                  className="flex items-center gap-3 rounded-2xl border border-hairline px-4 py-3"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cyan/10 text-cyan">
                    <FlaskConical size={15} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-text-primary">{r.title}</p>
                    <p className="truncate text-[11.5px] text-text-tertiary">
                      {r.labCategory ? LAB_CATEGORY_MAP[r.labCategory].label : t("lab.reportItem.labReportFallback")}
                      {r.patientRef ? ` · ${t("lab.reportItem.patientPrefix")} ${r.patientRef}` : ""} · {formatDate(r.date)}
                    </p>
                  </div>
                  {r.verified && (
                    <span className="flex shrink-0 items-center gap-1 rounded-full bg-emerald/10 px-2.5 py-1 text-[10.5px] font-medium text-emerald">
                      <BadgeCheck size={11} /> {t("lab.badge.registered")}
                    </span>
                  )}
                </motion.div>
              ))}
            </div>
          </Card>
        </div>
      </main>
      <ToastViewport />
    </div>
  );
}
