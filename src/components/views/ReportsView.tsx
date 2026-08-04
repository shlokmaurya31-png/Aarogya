"use client";

import { motion } from "framer-motion";
import { FileText, FlaskConical, Scan, FileHeart, Download, BadgeCheck } from "lucide-react";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Card } from "@/components/ui/Card";
import { downloadTextFile } from "@/lib/download";
import { useRecordsStore } from "@/store/useRecordsStore";
import { useTranslation } from "@/hooks/useTranslation";
import { LAB_CATEGORY_MAP } from "@/lib/lab-categories";
import type { ReportKind } from "@/types";

const KIND_META: Record<ReportKind, { icon: typeof FileText; label: string; color: string }> = {
  lab: { icon: FlaskConical, label: "Lab Report", color: "#dc2626" },
  radiology: { icon: Scan, label: "Radiology", color: "#0e7490" },
  discharge: { icon: FileHeart, label: "Discharge Summary", color: "#b45309" },
  prescription: { icon: FileText, label: "Prescription", color: "#15803d" },
};

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function formatSize(kb: number) {
  return kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
}

export function ReportsView() {
  const reports = useRecordsStore((s) => s.reports);
  const { t } = useTranslation();

  return (
    <div className="space-y-5">
      <SectionHeader
        eyebrow="Reports"
        title={t("reports.title")}
        subtitle={`${reports.length} documents · Uploaded directly by labs and hospitals, no paper involved`}
      />

      <Card className="p-0">
        <div className="divide-y divide-hairline">
          {reports.map((r, i) => {
            const meta = KIND_META[r.kind];
            const Icon = meta.icon;
            return (
              <motion.div
                key={r.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: i * 0.04 }}
                className="flex items-center gap-4 px-5 py-4 transition hover:bg-black/[0.025]"
              >
                <span
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
                  style={{ backgroundColor: meta.color + "1a", color: meta.color }}
                >
                  <Icon size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-medium text-text-primary">{r.title}</p>
                  <p className="truncate text-[12px] text-text-tertiary">
                    {r.labCategory ? LAB_CATEGORY_MAP[r.labCategory].label : meta.label} · {r.facility}
                  </p>
                </div>
                <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
                  {r.verified && (
                    <span className="flex items-center gap-1 rounded-full bg-emerald/10 px-2.5 py-1 text-[10.5px] font-medium text-emerald">
                      <BadgeCheck size={11} /> Verified
                    </span>
                  )}
                </div>
                <span className="hidden w-20 shrink-0 tabular-nums text-[12px] text-text-tertiary md:block">
                  {formatDate(r.date)}
                </span>
                <span className="hidden w-14 shrink-0 tabular-nums text-[11.5px] text-text-tertiary lg:block">
                  {formatSize(r.sizeKb)}
                </span>
                <button
                  onClick={() =>
                    downloadTextFile(
                      `${r.title.replace(/\s+/g, "-")}.txt`,
                      `${r.title}\n${meta.label} · ${r.facility}\nDate: ${formatDate(r.date)}\n\nThis is a placeholder export from Aarogya AI.`
                    )
                  }
                  className="shrink-0 rounded-full border border-hairline p-2 text-text-tertiary transition hover:border-cyan/30 hover:text-cyan"
                  aria-label={`Download ${r.title}`}
                >
                  <Download size={14} />
                </button>
              </motion.div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
