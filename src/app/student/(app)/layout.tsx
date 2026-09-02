import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/getCurrentUser";
import { ScholarShell } from "@/components/student/ScholarShell";

export default async function StudentAppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();

  if (!user || user.role !== "STUDENT") {
    redirect("/student");
  }
  if (user.studentProfile?.verificationStatus !== "VERIFIED") {
    redirect("/student/verify");
  }

  return (
    <ScholarShell
      displayName={user.studentProfile.preferredName || user.studentProfile.fullLegalName}
      institution={user.studentProfile.institution?.name ?? user.studentProfile.institutionNameFreeText ?? "Unaffiliated"}
      course={user.studentProfile.course}
      academicYear={user.studentProfile.academicYear}
      currentRotation={user.studentProfile.currentRotation ?? "General Medicine"}
      streakDays={user.studentProfile.streakDays}
    >
      {children}
    </ScholarShell>
  );
}
