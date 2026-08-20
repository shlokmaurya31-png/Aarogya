"use client";

import { useMemo, useState } from "react";
import { RotateCcw, Search } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useAuthStore } from "@/store/useAuthStore";
import { useToastStore } from "@/store/useToastStore";
import { useTranslation } from "@/hooks/useTranslation";
import { useRequireAdmin } from "@/hooks/useRequireAdmin";
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

export default function AdminDirectoryPage() {
  const { t } = useTranslation();
  const isAdmin = useRequireAdmin();
  const verificationApplications = useAuthStore((s) => s.verificationApplications);
  const resetApplication = useAuthStore((s) => s.resetApplication);
  const push = useToastStore((s) => s.push);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return verificationApplications
      .filter((a) => statusFilter === "all" || a.status === statusFilter)
      .filter((a) => roleFilter === "all" || a.role === roleFilter)
      .filter((a) => !q || a.name.toLowerCase().includes(q) || a.email.toLowerCase().includes(q) || a.facility.toLowerCase().includes(q))
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  }, [verificationApplications, statusFilter, roleFilter, query]);

  function handleReset(app: VerificationApplication) {
    resetApplication(app.id);
    push(`${app.name} ${t("admin.toast.reset")}`, "amber");
  }

  if (!isAdmin) return null;

  return (
    <div>
      <div>
        <h1 className="text-[20px] font-semibold tracking-tight text-text-primary">{t("admin.directory.title")}</h1>
        <p className="mt-1 text-[12.5px] text-text-secondary">{t("admin.directory.subtitle")}</p>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2.5">
        <div className="relative flex-1 min-w-[220px]">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("admin.directory.searchPlaceholder")}
            className="w-full rounded-md border border-hairline bg-black/[0.02] py-2 pl-9 pr-3.5 text-[12.5px] outline-none transition placeholder:text-text-tertiary focus:border-cyan/40 focus:bg-cyan/[0.03]"
          />
        </div>
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

      <p className="mt-3 text-[11.5px] text-text-tertiary">
        {visible.length} {t("admin.directory.resultsCount")}
      </p>

      <Card className="mt-3 rounded-lg overflow-x-auto p-0">
        {visible.length === 0 ? (
          <p className="p-6 text-center text-[13px] text-text-tertiary">{t("admin.directory.empty")}</p>
        ) : (
          <table className="w-full min-w-[680px] text-left text-[12px]">
            <thead>
              <tr className="border-b border-hairline text-[10.5px] uppercase tracking-[0.06em] text-text-tertiary">
                <th className="px-4 py-3 font-medium">{t("admin.directory.tableName")}</th>
                <th className="px-4 py-3 font-medium">{t("admin.directory.tableRole")}</th>
                <th className="px-4 py-3 font-medium">{t("admin.directory.tableFacility")}</th>
                <th className="px-4 py-3 font-medium">{t("admin.directory.tableStatus")}</th>
                <th className="px-4 py-3 font-medium">{t("admin.directory.tableSubmitted")}</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {visible.map((app) => (
                <tr key={app.id} className="border-b border-hairline last:border-0">
                  <td className="px-4 py-3">
                    <p className="font-medium text-text-primary">{app.name}</p>
                    <p className="text-[11px] text-text-tertiary">{app.email}</p>
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill label={t(`admin.role.${app.role}`)} tone="cyan" className="rounded-md" />
                  </td>
                  <td className="px-4 py-3 text-text-secondary">{app.facility}</td>
                  <td className="px-4 py-3">
                    <StatusPill label={t(`admin.status.${app.status}`)} tone={STATUS_TONE[app.status]} className="rounded-md" />
                  </td>
                  <td className="px-4 py-3 tabular-nums text-text-secondary">{app.submittedAt}</td>
                  <td className="px-4 py-3 text-right">
                    {app.status !== "pending" && (
                      <button
                        onClick={() => handleReset(app)}
                        className="inline-flex items-center gap-1.5 rounded-md border border-hairline px-3 py-1.5 text-[11px] font-medium text-text-secondary transition hover:border-amber/30 hover:text-amber"
                      >
                        <RotateCcw size={12} /> {t("admin.directory.action.revoke")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
