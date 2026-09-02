import { getCurrentUser } from "@/lib/auth/getCurrentUser";
import { AdminScholarSignIn } from "@/components/student/AdminScholarSignIn";
import { AdminStudentVerifications } from "@/components/student/AdminStudentVerifications";

/**
 * Reviews StudentProfile verification submissions (the Prisma-backed Scholar
 * system) from inside the existing (Zustand-authed) admin panel shell. The
 * old admin login has no server session, so this page requires its own
 * sign-in against the new scholar-auth system — see
 * docs/STUDENT_PLATFORM_ARCHITECTURE.md §2.10 for why these are two systems
 * living side by side rather than unified in this pass.
 */
export default async function AdminStudentVerificationsPage() {
  const user = await getCurrentUser();

  if (!user || user.role !== "AAROGYA_ADMIN") {
    return (
      <div>
        <h1 className="text-[20px] font-semibold tracking-tight">Aarogya Scholar — Student Verifications</h1>
        <p className="mt-1 text-[13px] text-text-secondary">
          This queue is backed by Aarogya Scholar&apos;s own account system. Sign in with a Scholar admin
          account to review submissions.
        </p>
        <div className="mt-5 max-w-sm">
          <AdminScholarSignIn />
        </div>
      </div>
    );
  }

  return <AdminStudentVerifications />;
}
