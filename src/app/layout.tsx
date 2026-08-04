import type { Metadata, Viewport } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import { PwaRegister } from "@/components/shared/PwaRegister";
import "./globals.css";

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
    <html lang="en" className={`${inter.variable} ${geistMono.variable} h-full`}>
      <body className="min-h-full flex flex-col font-sans antialiased">
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}
