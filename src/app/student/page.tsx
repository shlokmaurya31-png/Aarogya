import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/getCurrentUser";
import { StudentLanding } from "@/components/student/StudentLanding";

export default async function StudentEntryPage() {
  const user = await getCurrentUser();

  if (user && user.role === "STUDENT") {
    if (user.studentProfile?.verificationStatus === "VERIFIED") {
      redirect("/student/dashboard");
    }
    redirect("/student/verify");
  }

  return <StudentLanding alreadySignedInOtherRole={Boolean(user && user.role !== "STUDENT")} />;
}
