import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * The app-wide Button, restyled to the "Liquid Glass" look (per brand request)
 * while keeping its original variant/size API so no call site needs changes.
 *
 * The glass effect: a transparent body over a `backdrop-filter: url(#container-glass)`
 * displacement layer (the filter is mounted once globally in the root layout),
 * plus a layered inset/outer shadow for the refraction rim. Because the body is
 * transparent, the *label color* carries the variant meaning.
 */

type Variant = "primary" | "cta" | "brand" | "secondary" | "ghost" | "danger" | "subtle";
type Size = "sm" | "md" | "lg" | "icon";

// Glass is transparent, so variant = label/emphasis color.
const VARIANT_TEXT: Record<Variant, string> = {
  primary: "text-brand",
  brand: "text-brand",
  cta: "text-[color:var(--cta-text)]",
  danger: "text-danger",
  secondary: "text-text-primary",
  subtle: "text-text-secondary",
  ghost: "text-text-secondary",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 gap-1.5 px-4 text-[13px]",
  md: "h-9 gap-2 px-4 text-[13px]",
  lg: "h-11 gap-2 px-6 text-[14px]",
  icon: "size-9 justify-center",
};

// The refraction rim + inner glass highlights (light and dark tuned).
const GLASS_RIM =
  "shadow-[0_0_6px_rgba(0,0,0,0.03),0_2px_6px_rgba(0,0,0,0.08),inset_3px_3px_0.5px_-3px_rgba(0,0,0,0.9),inset_-3px_-3px_0.5px_-3px_rgba(0,0,0,0.85),inset_1px_1px_1px_-0.5px_rgba(0,0,0,0.6),inset_-1px_-1px_1px_-0.5px_rgba(0,0,0,0.6),inset_0_0_6px_6px_rgba(0,0,0,0.12),inset_0_0_2px_2px_rgba(0,0,0,0.06),0_0_12px_rgba(255,255,255,0.15)] " +
  "dark:shadow-[0_0_8px_rgba(0,0,0,0.03),0_2px_6px_rgba(0,0,0,0.08),inset_3px_3px_0.5px_-3.5px_rgba(255,255,255,0.09),inset_-3px_-3px_0.5px_-3.5px_rgba(255,255,255,0.85),inset_1px_1px_1px_-0.5px_rgba(255,255,255,0.6),inset_-1px_-1px_1px_-0.5px_rgba(255,255,255,0.6),inset_0_0_6px_6px_rgba(255,255,255,0.12),inset_0_0_2px_2px_rgba(255,255,255,0.06),0_0_12px_rgba(0,0,0,0.15)]";

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
        "focus-ring relative inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded-md font-medium",
        "transition-[transform,filter] duration-300 hover:scale-[1.03] active:scale-95",
        "disabled:pointer-events-none disabled:opacity-50 disabled:hover:scale-100",
        VARIANT_TEXT[variant],
        SIZES[size],
        className
      )}
      disabled={disabled || loading}
      {...props}
    >
      {/* Refraction rim */}
      <span className={cn("pointer-events-none absolute inset-0 z-0 rounded-md transition-all", GLASS_RIM)} />
      {/* Glass displacement layer (references the global #container-glass filter) */}
      <span
        className="pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-md"
        style={{ backdropFilter: 'url("#container-glass")' }}
      />
      {/* Label */}
      <span className="relative z-10 inline-flex items-center gap-2">
        {loading ? <Loader2 className="size-4 animate-spin" /> : leftIcon}
        {size !== "icon" && children}
        {!loading && rightIcon}
      </span>
    </button>
  );
}
