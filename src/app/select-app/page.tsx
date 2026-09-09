import Link from "next/link";
import { redirect } from "next/navigation";
import { GraduationCap, Building2 } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/getCurrentUser";
import { Card, CardLabel } from "@/components/ui/Card";

/**
 * AAROGYA_ADMIN is the one role that genuinely spans two products —
 * Scholar admin (student verifications) and Hospital OS — since it's the
 * platform-wide super-admin with real permissions in both. This is a
 * server-permission-backed picker (getCurrentUser() re-derives role from
 * the DB), not a client-submitted role selector.
 */
export default async function SelectAppPage() {
  const user = await getCurrentUser();
  if (!user || user.role !== "AAROGYA_ADMIN") {
    redirect("/login");
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4">
      <h1 className="text-[20px] font-semibold tracking-tight">Continue as</h1>
      <p className="mt-1 text-[13px] text-text-secondary">Signed in as {user.displayName} — Aarogya platform administrator.</p>

      <div className="mt-6 space-y-3">
        <Link href="/admin/student-verifications">
          <Card className="flex items-center gap-3 rounded-[20px] transition hover:border-emerald/40">
            <GraduationCap size={20} className="text-emerald" />
            <div>
              <p className="text-[13.5px] font-medium">Scholar Admin</p>
              <CardLabel className="mt-0.5 normal-case tracking-normal">Student verification queue</CardLabel>
            </div>
          </Card>
        </Link>
        <Link href="/hospital-os">
          <Card className="flex items-center gap-3 rounded-[20px] transition hover:border-cyan/40">
            <Building2 size={20} className="text-cyan" />
            <div>
              <p className="text-[13.5px] font-medium">Hospital OS</p>
              <CardLabel className="mt-0.5 normal-case tracking-normal">Command center, across facilities</CardLabel>
            </div>
          </Card>
        </Link>
      </div>
    </div>
  );
}
