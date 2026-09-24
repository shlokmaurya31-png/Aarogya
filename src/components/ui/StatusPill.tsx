import { cn } from "@/lib/utils";

// Semantic tones are the target vocabulary. The color-named keys
// (emerald/amber/red/cyan) are retained as backward-compatible aliases so
// existing callers keep rendering while the codebase migrates to roles.
const TONES = {
  // roles
  neutral: "text-text-secondary bg-fill-muted border-hairline",
  brand: "text-brand bg-brand/10 border-brand/20",
  // Care-teal accent pill (active/interactive labels).
  accent: "text-accent-strong bg-accent/12 border-accent/25",
  // Coral highlight pill (notifications, callout badges). Uses the deepened
  // cta-text so the label stays readable on the light coral tint.
  coral: "text-cta-text bg-cta/14 border-cta/30",
  cta: "text-cta-text bg-cta/14 border-cta/30",
  success: "text-success bg-success/12 border-success/25",
  warning: "text-warning bg-warning/12 border-warning/25",
  danger: "text-danger bg-danger/12 border-danger/25",
  critical: "text-critical bg-critical/14 border-critical/30 font-semibold",
  info: "text-info bg-info/12 border-info/25",
  pending: "text-text-secondary bg-fill-muted border-hairline",
  // legacy color aliases -> mapped to roles
  emerald: "text-success bg-success/12 border-success/25",
  amber: "text-warning bg-warning/12 border-warning/25",
  red: "text-danger bg-danger/12 border-danger/25",
  cyan: "text-brand bg-brand/10 border-brand/20",
} as const;

export type StatusTone = keyof typeof TONES;

export function StatusPill({
  label,
  tone = "neutral",
  dot = true,
  className,
}: {
  label: string;
  tone?: StatusTone;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium capitalize leading-5",
        TONES[tone],
        className
      )}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {label}
    </span>
  );
}

// A flat badge (no dot, squarer) for counts and labels.
export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: React.ReactNode;
  tone?: StatusTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium tabular-nums",
        TONES[tone],
        className
      )}
    >
      {children}
    </span>
  );
}
