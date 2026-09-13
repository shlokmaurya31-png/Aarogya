import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

// Every empty state should say what is empty, why it matters, and the next action.
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-12 text-center", className)}>
      {icon && (
        <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-fill-muted text-text-tertiary [&>svg]:size-5">
          {icon}
        </div>
      )}
      <p className="type-subheading text-text-primary">{title}</p>
      {description && <p className="mt-1 max-w-sm type-secondary">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
