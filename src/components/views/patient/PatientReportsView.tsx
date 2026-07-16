"use client";

import { motion } from "framer-motion";
import { FileText, FlaskConical, Scan, FileHeart, Download } from "lucide-react";
import { reports } from "@/lib/mock-data";
import { REPORT_FRIENDLY } from "@/lib/plain-language";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Card } from "@/components/ui/Card";
import type { ReportKind } from "@/types";

const KIND_ICON: Record<ReportKind, typeof FileText> = {
  lab: FlaskConical,
  radiology: Scan,
  discharge: FileHeart,
  prescription: FileText,
};

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

export function PatientReportsView() {
  return (
    <div className="space-y-5">
      <SectionHeader
        eyebrow="Reports"
        title="Your reports, explained simply"
        subtitle="No medical jargon — just what it means for you"
      />

      <div className="flex flex-col gap-3">
        {reports.map((r, i) => {
          const Icon = KIND_ICON[r.kind];
          return (
            <motion.div
              key={r.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: i * 0.05 }}
            >
              <Card>
                <div className="flex items-start gap-4">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-cyan/10 text-cyan">
                    <Icon size={17} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-[14px] font-semibold text-text-primary">{r.title}</p>
                      <button
                        className="shrink-0 rounded-full border border-hairline p-2 text-text-tertiary transition hover:border-cyan/30 hover:text-cyan"
                        aria-label={`Download ${r.title}`}
                      >
                        <Download size={14} />
                      </button>
                    </div>
                    <p className="mt-0.5 text-[12px] text-text-tertiary">
                      {r.facility} · {formatDate(r.date)}
                    </p>
                    <p className="mt-2.5 text-[13px] leading-relaxed text-text-secondary">
                      {REPORT_FRIENDLY[r.id] ?? "Ask Aarogya AI to explain this report to you."}
                    </p>
                  </div>
                </div>
              </Card>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
