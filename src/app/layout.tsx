import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { Geist_Mono } from "next/font/google";
import localFont from "next/font/local";
import { PwaRegister } from "@/components/shared/PwaRegister";
import { ThemeInit } from "@/components/shared/ThemeInit";
import { GlassFilter } from "@/components/ui/liquid-glass-button";
import "./globals.css";

const THEME_INIT_SCRIPT = `(function() {
  try {
    var stored = localStorage.getItem('aarogya-theme');
    var theme = null;
    if (stored) {
      var parsed = JSON.parse(stored);
      theme = parsed && parsed.state && parsed.state.theme;
    }
    if (!theme) {
      theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {}
})();`;

// Finlandica Text — the product's primary typeface, self-hosted (no external
// CDN) from the variable webfonts. One file covers the full 100–900 weight
// range, with a matching italic. Exposed as --font-finlandica and wired to
// --font-sans in globals.css so all `font-sans` text picks it up.
const finlandica = localFont({
  src: [
    { path: "./fonts/FinlandicaText-Variable.woff2", weight: "100 900", style: "normal" },
    { path: "./fonts/FinlandicaText-Italic-Variable.woff2", weight: "100 900", style: "italic" },
  ],
  variable: "--font-finlandica",
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Aarogya AI: India's Health Intelligence Platform",
  description:
    "A unified AI health operating system connecting patients, doctors, hospitals, labs, pharmacies, and insurers across India.",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Aarogya",
  },
};

export const viewport: Viewport = {
  themeColor: "#0e7490",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${finlandica.variable} ${geistMono.variable} h-full`} suppressHydrationWarning>
      <body className="min-h-full flex flex-col font-sans antialiased" suppressHydrationWarning>
        <Script id="theme-init" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {/* One global instance of the liquid-glass SVG filter (#container-glass),
            referenced by every Button's backdrop-filter — avoids duplicating the
            filter per button. */}
        <GlassFilter />
        {children}
        <PwaRegister />
        <ThemeInit />
      </body>
    </html>
  );
}
