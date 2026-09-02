"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { HeartPulse, LogOut } from "lucide-react";
import { ToastViewport } from "@/components/shared/ToastViewport";

export function PatientShell({ children, displayName }: { children: React.ReactNode; displayName: string }) {
  const router = useRouter();

  async function handleLogout() {
    await fetch("/api/scholar-auth/logout", { method: "POST" });
    router.push("/patient/login");
    router.refresh();
  }

  return (
    <div className="min-h-screen bg-surface text-text-primary">
      <ToastViewport />
      <header className="sticky top-0 z-40 border-b border-hairline bg-card px-4 py-3.5">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <Link href="/patient" className="flex items-center gap-2 text-[14px] font-semibold">
            <HeartPulse size={17} className="text-cyan" /> {displayName}&apos;s Health Record
          </Link>
          <button onClick={handleLogout} className="flex items-center gap-1.5 rounded-md border border-hairline px-3 py-1.5 text-[12px] text-text-secondary hover:border-red/30 hover:text-red">
            <LogOut size={13} /> Sign out
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6">{children}</main>
    </div>
  );
}
