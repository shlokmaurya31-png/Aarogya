"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { AdminSidebar } from "@/components/admin/AdminSidebar";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { useAuthStore } from "@/store/useAuthStore";
import { useTranslation } from "@/hooks/useTranslation";

export default function AdminDashboardLayout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const hasHydrated = useAuthStore((s) => s.hasHydrated);
  const verificationApplications = useAuthStore((s) => s.verificationApplications);

  useEffect(() => {
    if (!hasHydrated) return;
    if (!user || (user.role !== "admin" && user.role !== "staff")) router.replace("/admin/login");
  }, [hasHydrated, user, router]);

  if (!hasHydrated || !user || (user.role !== "admin" && user.role !== "staff")) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-ink text-text-tertiary">
        {t("admin.loading")}
      </div>
    );
  }

  const pendingCount = verificationApplications.filter((a) => a.status === "pending").length;

  return (
    <div className="flex min-h-screen bg-ink text-text-primary">
      <AdminSidebar pendingCount={pendingCount} role={user.role === "admin" ? "admin" : "staff"} />
      <main className="mx-auto w-full max-w-[1100px] px-6 py-8">{children}</main>
      <ToastViewport />
    </div>
  );
}
