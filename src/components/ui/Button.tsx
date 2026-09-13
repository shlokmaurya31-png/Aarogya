import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
type Size = "sm" | "md" | "lg" | "icon";

const VARIANTS: Record<Variant, string> = {
  // One primary action per view. Brand color on the background, white label.
  primary:
    "bg-brand-strong text-on-brand shadow-e1 hover:brightness-110 active:brightness-95",
  secondary:
    "border border-hairline bg-card text-text-primary hover:bg-fill-hover active:bg-fill-active",
  ghost: "text-text-secondary hover:bg-fill-hover hover:text-text-primary active:bg-fill-active",
  danger: "bg-danger text-white shadow-e1 hover:brightness-110 active:brightness-95",
  subtle: "bg-fill-muted text-text-primary hover:bg-fill-active",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 gap-1.5 px-3 text-[13px]",
  md: "h-9 gap-2 px-3.5 text-[13px]",
  lg: "h-11 gap-2 px-5 text-[14px]",
  icon: "h-9 w-9 justify-center",
};

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  leftIcon,
  rightIcon,
  className,
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}) {
  return (
    <button
      className={cn(
        "focus-ring inline-flex items-center justify-center whitespace-nowrap rounded-control font-medium transition-[background-color,box-shadow,filter] duration-[130ms] ease-[cubic-bezier(0.2,0,0,1)] disabled:pointer-events-none disabled:opacity-55",
        VARIANTS[variant],
        SIZES[size],
        className
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : leftIcon}
      {size !== "icon" && children}
      {!loading && rightIcon}
    </button>
  );
}
