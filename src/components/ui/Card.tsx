import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "react";

export function Card({
  className,
  children,
  raised = false,
  ...props
}: HTMLAttributes<HTMLDivElement> & { raised?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-[20px] border border-hairline p-5",
        raised ? "bg-card-raised" : "bg-card",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn("text-[11px] uppercase tracking-[0.14em] text-text-tertiary", className)}>
      {children}
    </p>
  );
}
