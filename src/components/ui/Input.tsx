import { cn } from "@/lib/utils";
import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes, ReactNode } from "react";

const fieldBase =
  "w-full rounded-field border border-hairline bg-fill-subtle text-text-primary outline-none transition-[border-color,box-shadow] duration-[130ms] placeholder:text-text-tertiary focus:border-accent focus:ring-2 focus:ring-accent/30 disabled:opacity-55";

// 16px on mobile stops iOS zoom, 13px on larger screens for density.
const fieldSize = "px-3 py-2.5 text-[16px] sm:text-[13px]";

export function Input({ className, invalid, ...props }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      className={cn(fieldBase, fieldSize, invalid && "border-danger focus:border-danger focus:ring-danger/25", className)}
      {...props}
    />
  );
}

export function Textarea({ className, invalid, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      className={cn(fieldBase, "px-3 py-2.5 text-[16px] leading-relaxed sm:text-[13px]", invalid && "border-danger focus:border-danger focus:ring-danger/25", className)}
      {...props}
    />
  );
}

export function Select({ className, invalid, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select
      className={cn(fieldBase, fieldSize, "appearance-none bg-[length:14px] bg-[right_0.6rem_center] bg-no-repeat pr-9", invalid && "border-danger", className)}
      style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")" }}
      {...props}
    >
      {children}
    </select>
  );
}

export function Field({
  label,
  hint,
  error,
  required,
  htmlFor,
  children,
  className,
}: {
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      {label && (
        <label htmlFor={htmlFor} className="flex items-center gap-1 text-[12px] font-medium text-text-secondary">
          {label}
          {required && <span className="text-danger" aria-hidden>*</span>}
        </label>
      )}
      {children}
      {error ? (
        <p className="text-[11.5px] text-danger">{error}</p>
      ) : hint ? (
        <p className="text-[11.5px] text-text-tertiary">{hint}</p>
      ) : null}
    </div>
  );
}
