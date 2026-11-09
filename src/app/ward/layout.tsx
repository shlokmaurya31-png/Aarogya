import type { Metadata, Viewport } from "next";

/** Flagship 4c — the ward tablet's installable app (its own manifest and service worker, scoped to /ward). */
export const metadata: Metadata = {
  title: "Aarogya ward round",
  manifest: "/ward.webmanifest",
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { themeColor: "#0e7490" };

export default function WardLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-dvh bg-background text-foreground">{children}</div>;
}
