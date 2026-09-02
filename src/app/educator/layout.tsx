import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/getCurrentUser";
import { GraduationCap, LayoutGrid, FilePlus } from "lucide-react";

export default async function EducatorLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user || (user.role !== "EDUCATOR" && user.role !== "AAROGYA_ADMIN")) {
    redirect("/student");
  }

  return (
    <div className="min-h-screen bg-surface text-text-primary">
      <header className="border-b border-hairline bg-card px-6 py-4">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <Link href="/educator/cases" className="flex items-center gap-2 text-[14px] font-semibold">
            <GraduationCap size={17} className="text-cyan" /> Aarogya Academy — Educator
          </Link>
          <nav className="flex items-center gap-4 text-[12.5px] text-text-secondary">
            <Link href="/educator/cases" className="flex items-center gap-1.5 hover:text-cyan"><LayoutGrid size={13} /> Cases</Link>
            <Link href="/educator/cases/create" className="flex items-center gap-1.5 hover:text-cyan"><FilePlus size={13} /> Create case</Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
