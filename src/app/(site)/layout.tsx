import type { ReactNode } from "react";
import { SiteHeader } from "@/components/site/SiteHeader";
import { Footer } from "@/components/landing/Footer";

/**
 * Shared chrome for the public content pages (standards, company). The root
 * layout supplies <html>/<body> + theme; this adds the marketing header and
 * reuses the landing Footer so these pages feel part of the same website.
 */
export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-ink text-text-primary antialiased">
      <SiteHeader />
      <main>{children}</main>
      <Footer />
    </div>
  );
}
