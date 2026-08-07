import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { Geist_Mono, Inter } from "next/font/google";
import { PwaRegister } from "@/components/shared/PwaRegister";
import { ThemeInit } from "@/components/shared/ThemeInit";
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

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
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
    <html lang="en" className={`${inter.variable} ${geistMono.variable} h-full`} suppressHydrationWarning>
      <body className="min-h-full flex flex-col font-sans antialiased" suppressHydrationWarning>
        <Script id="theme-init" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {children}
        <PwaRegister />
        <ThemeInit />
      </body>
    </html>
  );
}
