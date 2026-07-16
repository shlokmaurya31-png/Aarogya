import { cn } from "@/lib/utils";

const TONES = {
  emerald: "text-emerald bg-emerald/10 border-emerald/20",
  amber: "text-amber bg-amber/10 border-amber/20",
  red: "text-red bg-red/10 border-red/20",
  cyan: "text-cyan bg-cyan/10 border-cyan/20",
  neutral: "text-text-secondary bg-white/[0.04] border-hairline",
} as const;

export function StatusPill({
  label,
  tone = "neutral",
  className,
}: {
  label: string;
  tone?: keyof typeof TONES;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium capitalize",
        TONES[tone],
        className
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}
