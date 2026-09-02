"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { GraduationCap, LayoutDashboard, LogOut, Settings, ShieldCheck, UserCog, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/store/useAuthStore";
import { useTranslation } from "@/hooks/useTranslation";

export function AdminSidebar({ pendingCount, role }: { pendingCount: number; role: "admin" | "staff" }) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const router = useRouter();
  const logout = useAuthStore((s) => s.logout);

  const NAV = [
    { href: "/admin", label: t("admin.sidebar.overview"), icon: LayoutDashboard },
    { href: "/admin/verifications", label: t("admin.sidebar.verifications"), icon: ShieldCheck, badge: pendingCount },
    { href: "/admin/student-verifications", label: "Aarogya Scholar", icon: GraduationCap, badge: undefined },
    ...(role === "admin"
      ? [
          { href: "/admin/directory", label: t("admin.sidebar.directory"), icon: Users, badge: undefined },
          { href: "/admin/staff", label: t("admin.sidebar.staff"), icon: UserCog, badge: undefined },
        ]
      : []),
  ];

  return (
    <aside className="sticky top-0 flex h-screen w-[236px] shrink-0 flex-col border-r border-hairline bg-ink px-3.5 py-5">
      <div className="flex items-center gap-2 px-2 text-[13.5px] font-semibold text-text-primary">
        <ShieldCheck size={17} className="text-cyan" />
        {t("admin.sidebar.brand")}
      </div>

      <nav className="mt-7 flex flex-1 flex-col gap-1">
        {NAV.map((item) => {
          const active = item.href === "/admin" ? pathname === "/admin" : pathname?.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center justify-between gap-2 rounded-md px-3 py-2.5 text-[13px] font-medium transition",
                active ? "bg-cyan/10 text-cyan" : "text-text-secondary hover:bg-black/[0.03] hover:text-text-primary"
              )}
            >
              <span className="flex items-center gap-2.5">
                <Icon size={15} />
                {item.label}
              </span>
              {!!item.badge && (
                <span className="rounded-md bg-amber/15 px-1.5 py-0.5 text-[10.5px] font-semibold tabular-nums text-amber">
                  {item.badge}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="flex flex-col gap-1 border-t border-hairline pt-3">
        <Link
          href="/settings"
          className="flex items-center gap-2.5 rounded-md px-3 py-2.5 text-[13px] text-text-secondary transition hover:bg-black/[0.03] hover:text-text-primary"
        >
          <Settings size={15} /> {t("admin.nav.settings")}
        </Link>
        <button
          onClick={() => {
            logout();
            router.push("/");
          }}
          className="flex items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-[13px] text-text-secondary transition hover:bg-red/10 hover:text-red"
        >
          <LogOut size={15} /> {t("admin.nav.logout")}
        </button>
      </div>
    </aside>
  );
}
