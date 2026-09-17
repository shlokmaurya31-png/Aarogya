"use client";

import Link from "next/link";
import { ThemeToggle } from "@/components/navigation/ThemeToggle";

/**
 * Shared marketing-site header for the standalone content pages (standards,
 * company). Deliberately independent of the landing page's Lenis-driven HeroNav
 * so it works on any scrollable page. Sticky, translucent, theme-aware, and
 * keyboard-accessible; mirrors the existing brand language (wordmark + pills).
 */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-hairline bg-ink/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1100px] items-center justify-between px-6 py-3.5 sm:px-10">
        <Link href="/" className="flex items-center gap-2 text-[14px] font-semibold tracking-tight" aria-label="Aarogya home">
          <span className="text-text-primary">Aarogya</span>
          <span aria-hidden className="text-emerald select-none">&#10010;</span>
        </Link>

        <nav aria-label="Primary" className="flex items-center gap-1 sm:gap-2">
          <Link
            href="/standards/abdm"
            className="hidden rounded-full px-3 py-2 text-[13px] font-medium text-text-secondary transition-colors hover:text-text-primary sm:inline-block"
          >
            Standards
          </Link>
          <Link
            href="/company/about"
            className="hidden rounded-full px-3 py-2 text-[13px] font-medium text-text-secondary transition-colors hover:text-text-primary sm:inline-block"
          >
            Company
          </Link>
          <ThemeToggle />
          <Link
            href="/login"
            className="rounded-full border border-hairline bg-surface px-4 py-2 text-[12.5px] font-medium text-text-primary transition hover:border-cyan/40 hover:text-cyan"
          >
            Sign in
          </Link>
        </nav>
      </div>
    </header>
  );
}
