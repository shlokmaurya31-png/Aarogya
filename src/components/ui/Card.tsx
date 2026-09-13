import { cn } from "@/lib/utils";
import type { HTMLAttributes, ReactNode } from "react";

export function Card({
  className,
  children,
  raised = false,
  padded = true,
  ...props
}: HTMLAttributes<HTMLDivElement> & { raised?: boolean; padded?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-surface border border-hairline",
        raised ? "bg-card-raised shadow-e1" : "bg-card",
        padded && "p-4",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  icon,
  title,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      <div className="flex min-w-0 items-center gap-2">
        {icon && <span className="text-brand [&>svg]:size-[15px]">{icon}</span>}
        <CardLabel>{title}</CardLabel>
      </div>
      {action}
    </div>
  );
}

export function CardLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("type-label truncate", className)}>{children}</p>
  );
}
