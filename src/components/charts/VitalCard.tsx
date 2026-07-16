"use client";

import { AreaChart, Area, ResponsiveContainer, Tooltip } from "recharts";
import { motion } from "framer-motion";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { VitalSeries } from "@/types";
import { RISK_COLOR } from "@/lib/risk";
import { cn } from "@/lib/utils";

export function VitalCard({ vital, delay = 0 }: { vital: VitalSeries; delay?: number }) {
  const up = vital.delta >= 0;
  const riskColor = RISK_COLOR[vital.risk];

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1], delay }}
      className="group rounded-[20px] border border-hairline bg-card p-4 transition-colors duration-300 hover:border-hairline-strong"
    >
      <div className="flex items-center justify-between">
        <p className="text-[11px] uppercase tracking-[0.12em] text-text-tertiary">
          {vital.label}
        </p>
        <span
          className={cn(
            "flex items-center gap-0.5 text-[11px] font-medium",
            up ? "text-amber" : "text-emerald"
          )}
        >
          {up ? <ArrowUp size={11} /> : <ArrowDown size={11} />}
          {Math.abs(vital.delta)}
        </span>
      </div>

      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="tabular-nums text-[26px] font-semibold">{vital.current}</span>
        <span className="text-[12px] text-text-tertiary">{vital.unit}</span>
      </div>

      <div className="mt-2 h-14">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={vital.data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={`grad-${vital.id}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={riskColor} stopOpacity={0.35} />
                <stop offset="100%" stopColor={riskColor} stopOpacity={0} />
              </linearGradient>
            </defs>
            <Tooltip
              cursor={false}
              contentStyle={{
                background: "#151515",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 12,
                fontSize: 11,
                padding: "4px 10px",
              }}
              labelFormatter={() => ""}
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke={riskColor}
              strokeWidth={2}
              fill={`url(#grad-${vital.id})`}
              isAnimationActive
              animationDuration={1200}
              animationEasing="ease-out"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </motion.div>
  );
}
