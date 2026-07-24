"use client";

import { motion } from "framer-motion";
import { labResults } from "@/lib/mock-data";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Card, CardLabel } from "@/components/ui/Card";
import { RISK_COLOR, RISK_LABEL } from "@/lib/risk";
import type { LabResult } from "@/types";

function groupByPanel(results: LabResult[]) {
  const groups = new Map<string, LabResult[]>();
  for (const r of results) {
    if (!groups.has(r.panel)) groups.set(r.panel, []);
    groups.get(r.panel)!.push(r);
  }
  return Array.from(groups.entries());
}

function RangeBar({ result }: { result: LabResult }) {
  const { value, refLow, refHigh } = result;
  const span = refHigh - refLow || 1;
  const padding = span * 0.4;
  const min = refLow - padding;
  const max = refHigh + padding;
  const pct = Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
  const lowPct = ((refLow - min) / (max - min)) * 100;
  const highPct = ((refHigh - min) / (max - min)) * 100;
  const color = RISK_COLOR[result.risk];

  return (
    <div className="relative h-1.5 w-full rounded-full bg-black/[0.07]">
      <div
        className="absolute h-full rounded-full bg-black/[0.16]"
        style={{ left: `${lowPct}%`, width: `${highPct - lowPct}%` }}
      />
      <motion.div
        initial={{ left: "0%" }}
        animate={{ left: `${pct}%` }}
        transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-ink"
        style={{ backgroundColor: color }}
      />
    </div>
  );
}

export function LabResultsView() {
  const groups = groupByPanel(labResults);
  const flagged = labResults.filter((r) => r.risk === "elevated" || r.risk === "critical").length;

  return (
    <div className="space-y-5">
      <SectionHeader
        eyebrow="Lab Results"
        title="Diagnostics, structured"
        subtitle={`${labResults.length} results across ${groups.length} panels · ${flagged} flagged for review`}
      />

      <div className="space-y-4">
        {groups.map(([panel, results], gi) => (
          <motion.div
            key={panel}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: gi * 0.06 }}
          >
            <Card>
              <CardLabel>{panel}</CardLabel>
              <div className="mt-3 divide-y divide-hairline">
                {results.map((r) => (
                  <div key={r.id} className="grid grid-cols-12 items-center gap-3 py-3">
                    <div className="col-span-4 sm:col-span-3">
                      <p className="text-[13px] font-medium text-text-primary">{r.test}</p>
                      <p className="text-[11px] text-text-tertiary">
                        Ref {r.refLow}–{r.refHigh} {r.unit}
                      </p>
                    </div>
                    <div className="col-span-4 hidden sm:block">
                      <RangeBar result={r} />
                    </div>
                    <div className="col-span-4 sm:col-span-2 text-right sm:text-left">
                      <span className="tabular-nums text-[14px] font-semibold">{r.value}</span>
                      <span className="ml-1 text-[11px] text-text-tertiary">{r.unit}</span>
                    </div>
                    <div className="col-span-4 sm:col-span-3 flex justify-end">
                      <span
                        className="rounded-full border px-2.5 py-1 text-[10.5px] font-medium"
                        style={{
                          color: RISK_COLOR[r.risk],
                          borderColor: RISK_COLOR[r.risk] + "33",
                          backgroundColor: RISK_COLOR[r.risk] + "14",
                        }}
                      >
                        {RISK_LABEL[r.risk]}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
