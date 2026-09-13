import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown } from "lucide-react";
import { Card } from "./Card";
import type { ReactNode } from "react";

// A KPI tile. Delta semantics are caller-defined (some metrics are "up is good",
// others "up is bad"), so `deltaGood` controls the color rather than the sign.
export function Stat({
  label,
  value,
  unit,
  icon,
  deltaPct,
  deltaLabel,
  deltaGood,
  className,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  icon?: ReactNode;
  deltaPct?: number;
  deltaLabel?: string;
  deltaGood?: boolean;
  className?: string;
}) {
  const hasDelta = deltaPct !== undefined && deltaPct !== 0;
  const up = (deltaPct ?? 0) > 0;
  const good = deltaGood ?? !up;
  return (
    <Card padded={false} className={cn("p-3.5", className)}>
      <div className="flex items-center justify-between">
        <p className="type-label truncate">{label}</p>
        {icon && <span className="text-text-tertiary [&>svg]:size-[15px]">{icon}</span>}
      </div>
      <div className="mt-2 flex items-baseline gap-1">
        <span className="type-metric text-text-primary">{value}</span>
        {unit && <span className="text-[13px] text-text-tertiary">{unit}</span>}
      </div>
      {hasDelta && (
        <span
          className={cn(
            "mt-1.5 inline-flex items-center gap-0.5 text-[11px] tabular-nums",
            good ? "text-success" : "text-warning"
          )}
        >
          {up ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
          {Math.abs(deltaPct!)}% {deltaLabel}
        </span>
      )}
    </Card>
  );
}
