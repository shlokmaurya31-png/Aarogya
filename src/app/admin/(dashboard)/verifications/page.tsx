"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Check, X } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useAuthStore } from "@/store/useAuthStore";
import { useToastStore } from "@/store/useToastStore";
import { useTranslation } from "@/hooks/useTranslation";
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

export default function AdminVerificationsPage() {
  const { t } = useTranslation();
  const verificationApplications = useAuthStore((s) => s.verificationApplications);
  const approveApplication = useAuthStore((s) => s.approveApplication);
  const rejectApplication = useAuthStore((s) => s.rejectApplication);
  const push = useToastStore((s) => s.push);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("pending");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");

  const visible = useMemo(
    () =>
      verificationApplications
        .filter((a) => statusFilter === "all" || a.status === statusFilter)
        .filter((a) => roleFilter === "all" || a.role === roleFilter),
    [verificationApplications, statusFilter, roleFilter]
  );

  const pendingCount = verificationApplications.filter((a) => a.status === "pending").length;
  const verifiedCount = verificationApplications.filter((a) => a.status === "verified").length;
  const labCount = verificationApplications.filter((a) => a.role === "lab").length;

  function handleApprove(app: VerificationApplication) {
    approveApplication(app.id);
    push(`${app.name} ${t("admin.toast.approved")}`, "emerald");
  }

  function handleReject(app: VerificationApplication) {
    rejectApplication(app.id);
    push(`${app.name}'s ${t("admin.toast.rejected")}`, "red");
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
      </div>

      <div className="mt-4 space-y-3">
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
            <Card className="rounded-lg flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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
                <div className="flex shrink-0 items-center gap-2">
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
    </div>
  );
}
