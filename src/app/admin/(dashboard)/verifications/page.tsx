"use client";

import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Building2, Check, Copy, Download, Search, Stethoscope, X } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useAuthStore } from "@/store/useAuthStore";
import { useToastStore } from "@/store/useToastStore";
import { useTranslation } from "@/hooks/useTranslation";
import { downloadTextFile } from "@/lib/download";
import { cn, timeAgo } from "@/lib/utils";
import type { VerificationApplication } from "@/types";

const STATUS_TONE: Record<VerificationApplication["status"], "amber" | "emerald" | "red"> = {
  pending: "amber",
  verified: "emerald",
  rejected: "red",
};

const STATUS_FILTERS = ["all", "pending", "verified", "rejected"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const ROLE_FILTERS = ["all", "doctor", "lab", "hospital"] as const;
type RoleFilter = (typeof ROLE_FILTERS)[number];

type SortOption = "newest" | "oldest";

function toCsvValue(value: string | number) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

export default function AdminVerificationsPage() {
  const { t } = useTranslation();
  const verificationApplications = useAuthStore((s) => s.verificationApplications);
  const activityLog = useAuthStore((s) => s.activityLog);
  const approveApplication = useAuthStore((s) => s.approveApplication);
  const rejectApplication = useAuthStore((s) => s.rejectApplication);
  const push = useToastStore((s) => s.push);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("pending");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [search, setSearch] = useState("");
  const [sortOption, setSortOption] = useState<SortOption>("newest");
  const [selected, setSelected] = useState<VerificationApplication | null>(null);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = verificationApplications
      .filter((a) => statusFilter === "all" || a.status === statusFilter)
      .filter((a) => roleFilter === "all" || a.role === roleFilter)
      .filter(
        (a) =>
          !q ||
          a.name.toLowerCase().includes(q) ||
          a.email.toLowerCase().includes(q) ||
          a.facility.toLowerCase().includes(q) ||
          a.registrationId.toLowerCase().includes(q)
      );
    return [...filtered].sort((a, b) => {
      const cmp = a.submittedAt.localeCompare(b.submittedAt);
      return sortOption === "newest" ? -cmp : cmp;
    });
  }, [verificationApplications, statusFilter, roleFilter, search, sortOption]);

  const pendingCount = verificationApplications.filter((a) => a.status === "pending").length;
  const verifiedCount = verificationApplications.filter((a) => a.status === "verified").length;
  const labCount = verificationApplications.filter((a) => a.role === "lab").length;

  function handleApprove(app: VerificationApplication) {
    approveApplication(app.id);
    push(`${app.name} ${t("admin.toast.approved")}`, "emerald");
    setSelected(null);
  }

  function handleReject(app: VerificationApplication) {
    rejectApplication(app.id);
    push(`${app.name}'s ${t("admin.toast.rejected")}`, "red");
    setSelected(null);
  }

  function handleCopyEmail(email: string) {
    navigator.clipboard?.writeText(email);
    push(t("admin.queue.detail.copyToast"), "cyan");
  }

  function handleDownloadProof(app: VerificationApplication) {
    const stub = `Proof of ${app.role} credential\nApplicant: ${app.name}\nRegistration ID: ${app.registrationId}\nFacility: ${app.facility}\nOriginal file on record: ${app.proofFileName}\nSubmitted: ${app.submittedAt}\n\nThis prototype has no document storage backend — production would stream the verified file from a secure vault.`;
    downloadTextFile(`${app.proofFileName.replace(/\.[a-z0-9]+$/i, "")}-summary.txt`, stub);
    push(t("admin.queue.detail.downloadToast"), "cyan");
  }

  function handleExportCsv() {
    const header = ["Name", "Role", "Status", "Specialty", "Facility", "Registration ID", "Email", "Submitted"];
    const rows = visible.map((a) => [
      a.name,
      a.role,
      a.status,
      a.specialty ?? "",
      a.facility,
      a.registrationId,
      a.email,
      a.submittedAt,
    ]);
    const csv = [header, ...rows].map((row) => row.map(toCsvValue).join(",")).join("\n");
    downloadTextFile(`aarogya-applications-${new Date().toISOString().slice(0, 10)}.csv`, csv);
    push(`${visible.length} ${t("admin.queue.exportToastSuffix")}`, "cyan");
  }

  return (
    <div>
      <div>
        <h1 className="text-[20px] font-semibold tracking-tight text-text-primary">{t("admin.queue.title")}</h1>
        <p className="mt-1 text-[12.5px] text-text-secondary">{t("admin.queue.subtitle")}</p>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-4">
        <Card className="rounded-lg">
          <CardLabel>{t("admin.stat.pendingVerification")}</CardLabel>
          <p className="mt-2 text-[28px] font-semibold tabular-nums">{pendingCount}</p>
        </Card>
        <Card className="rounded-lg">
          <CardLabel>{t("admin.stat.verified")}</CardLabel>
          <p className="mt-2 text-[28px] font-semibold tabular-nums">{verifiedCount}</p>
        </Card>
        <Card className="rounded-lg">
          <CardLabel>{t("admin.stat.labApplications")}</CardLabel>
          <p className="mt-2 text-[28px] font-semibold tabular-nums">{labCount}</p>
        </Card>
        <Card className="rounded-lg">
          <CardLabel>{t("admin.stat.totalApplications")}</CardLabel>
          <p className="mt-2 text-[28px] font-semibold tabular-nums">{verificationApplications.length}</p>
        </Card>
      </div>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[15px] font-medium">{t("admin.queue.title")}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("admin.queue.searchPlaceholder")}
              className="w-[210px] rounded-md border border-hairline bg-black/[0.025] py-1.5 pl-8 pr-3 text-[11.5px] outline-none transition focus:border-cyan/40"
            />
          </div>
          <button
            onClick={() => setSortOption((s) => (s === "newest" ? "oldest" : "newest"))}
            className="rounded-md border border-hairline px-3 py-1.5 text-[11.5px] text-text-secondary transition hover:border-cyan/30 hover:text-cyan"
          >
            {sortOption === "newest" ? t("admin.queue.sortNewest") : t("admin.queue.sortOldest")}
          </button>
          <button
            onClick={handleExportCsv}
            className="flex items-center gap-1.5 rounded-md border border-hairline px-3 py-1.5 text-[11.5px] text-text-secondary transition hover:border-cyan/30 hover:text-cyan"
          >
            <Download size={12} /> {t("admin.queue.exportCsv")}
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border border-hairline bg-black/[0.025] p-1">
          {ROLE_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setRoleFilter(f)}
              className={`rounded-md px-3 py-1 text-[11.5px] capitalize transition ${
                roleFilter === f ? "bg-cyan text-ink" : "text-text-secondary hover:text-text-primary"
              }`}
            >
              {f === "all" ? t("admin.filter.allRoles") : t(`admin.role.${f}`)}
            </button>
          ))}
        </div>
        <div className="inline-flex rounded-md border border-hairline bg-black/[0.025] p-1">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              className={`rounded-md px-3 py-1 text-[11.5px] capitalize transition ${
                statusFilter === f ? "bg-cyan text-ink" : "text-text-secondary hover:text-text-primary"
              }`}
            >
              {t(`admin.status.${f}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          {visible.length === 0 && (
            <Card className="rounded-lg text-center text-[13px] text-text-tertiary">{t("admin.empty.noApplications")}</Card>
          )}
          {visible.map((app) => (
            <motion.div
              key={app.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
            >
              <Card
                onClick={() => setSelected(app)}
                className="rounded-lg flex cursor-pointer flex-col gap-3 transition hover:border-cyan/30 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2.5">
                    <p className="text-[13.5px] font-medium">{app.name}</p>
                    <StatusPill label={t(`admin.role.${app.role}`)} tone="cyan" className="rounded-md" />
                    <StatusPill label={t(`admin.status.${app.status}`)} tone={STATUS_TONE[app.status]} className="rounded-md" />
                  </div>
                  <p className="mt-1 text-[12px] text-text-tertiary">
                    {app.specialty ? `${app.specialty} · ` : ""}
                    {app.facility} · {app.role === "lab" ? t("admin.label.accreditation") : t("admin.label.registration")} {t("admin.label.id")}: {app.registrationId}
                  </p>
                  <p className="mt-1 text-[11.5px] text-text-tertiary">
                    {app.email} · {t("admin.label.submitted")} {app.submittedAt} · {t("admin.label.proof")}: {app.proofFileName}
                  </p>
                </div>
                {app.status === "pending" && (
                  <div className="flex shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => handleApprove(app)}
                      className="flex items-center gap-1.5 rounded-md bg-emerald px-3.5 py-2 text-[12px] font-medium text-white transition hover:brightness-110"
                    >
                      <Check size={13} /> {t("admin.action.approve")}
                    </button>
                    <button
                      onClick={() => handleReject(app)}
                      className="flex items-center gap-1.5 rounded-md border border-red/30 px-3.5 py-2 text-[12px] font-medium text-red transition hover:bg-red/10"
                    >
                      <X size={13} /> {t("admin.action.reject")}
                    </button>
                  </div>
                )}
              </Card>
            </motion.div>
          ))}
        </div>

        <Card className="h-fit rounded-lg">
          <CardLabel>{t("admin.queue.recentActivityTitle")}</CardLabel>
          {activityLog.length === 0 ? (
            <p className="mt-3 text-[12.5px] text-text-tertiary">{t("admin.queue.recentActivityEmpty")}</p>
          ) : (
            <div className="mt-3 space-y-3">
              {activityLog.slice(0, 8).map((event) => (
                <div key={event.id} className="flex items-start gap-2.5">
                  <span
                    className={cn(
                      "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
                      event.type === "approved" ? "bg-emerald/10 text-emerald" : "bg-red/10 text-red"
                    )}
                  >
                    {event.type === "approved" ? <Check size={11} /> : <X size={11} />}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-[12.5px]">
                      <span className="font-medium">{event.applicantName}</span>{" "}
                      <span className="text-text-tertiary">
                        {event.type === "approved" ? t("admin.queue.activityApproved") : t("admin.queue.activityRejected")} ·{" "}
                        {t(`admin.role.${event.role}`)}
                      </span>
                    </p>
                    <p className="text-[11px] text-text-tertiary">{timeAgo(event.timestamp)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <AnimatePresence>
        {selected && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/30 px-4 py-[8vh]"
            onClick={() => setSelected(null)}
          >
            <motion.div
              initial={{ opacity: 0, y: -12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.98 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-lg rounded-[20px] border border-hairline bg-card"
            >
              <div className="flex items-center justify-between border-b border-hairline px-5 py-4">
                <div className="flex items-center gap-2.5">
                  {selected.role === "doctor" ? (
                    <Stethoscope size={15} className="text-cyan" />
                  ) : (
                    <Building2 size={15} className="text-cyan" />
                  )}
                  <p className="text-[14px] font-semibold">{selected.name}</p>
                  <StatusPill label={t(`admin.status.${selected.status}`)} tone={STATUS_TONE[selected.status]} className="rounded-md" />
                </div>
                <button onClick={() => setSelected(null)} aria-label="Close" className="text-text-tertiary transition hover:text-text-secondary">
                  <X size={16} />
                </button>
              </div>

              <div className="space-y-3 px-5 py-4 text-[12.5px]">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">{t("admin.directory.tableRole")}</p>
                    <p className="mt-0.5 capitalize">{t(`admin.role.${selected.role}`)}</p>
                  </div>
                  {selected.specialty && (
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">Specialty</p>
                      <p className="mt-0.5">{selected.specialty}</p>
                    </div>
                  )}
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">
                      {selected.role === "lab" ? t("admin.label.accreditation") : t("admin.label.registration")} {t("admin.label.id")}
                    </p>
                    <p className="mt-0.5">{selected.registrationId}</p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">{t("admin.directory.tableSubmitted")}</p>
                    <p className="mt-0.5">{selected.submittedAt}</p>
                  </div>
                  <div className="col-span-2">
                    <p className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">{t("admin.directory.tableFacility")}</p>
                    <p className="mt-0.5">{selected.facility}</p>
                  </div>
                  <div className="col-span-2 flex items-center justify-between">
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">Email</p>
                      <p className="mt-0.5">{selected.email}</p>
                    </div>
                    <button
                      onClick={() => handleCopyEmail(selected.email)}
                      className="flex items-center gap-1 rounded-md border border-hairline px-2.5 py-1 text-[11px] text-text-secondary transition hover:border-cyan/30 hover:text-cyan"
                    >
                      <Copy size={11} /> {t("admin.queue.detail.copy")}
                    </button>
                  </div>
                  <div className="col-span-2 flex items-center justify-between rounded-md border border-hairline px-3 py-2">
                    <span className="text-text-secondary">{selected.proofFileName}</span>
                    <button
                      onClick={() => handleDownloadProof(selected)}
                      className="flex items-center gap-1 text-[11px] text-cyan hover:underline"
                    >
                      <Download size={11} /> {t("admin.queue.detail.download")}
                    </button>
                  </div>
                </div>
              </div>

              {selected.status === "pending" && (
                <div className="flex items-center justify-end gap-2 border-t border-hairline px-5 py-4">
                  <button
                    onClick={() => handleReject(selected)}
                    className="flex items-center gap-1.5 rounded-md border border-red/30 px-4 py-2 text-[12.5px] font-medium text-red transition hover:bg-red/10"
                  >
                    <X size={13} /> {t("admin.action.reject")}
                  </button>
                  <button
                    onClick={() => handleApprove(selected)}
                    className="flex items-center gap-1.5 rounded-md bg-emerald px-4 py-2 text-[12.5px] font-medium text-white transition hover:brightness-110"
                  >
                    <Check size={13} /> {t("admin.action.approve")}
                  </button>
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
