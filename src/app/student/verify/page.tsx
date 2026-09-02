import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/getCurrentUser";
import { VerificationWizard } from "@/components/student/VerificationWizard";
import { VerificationStatusPanel } from "@/components/student/VerificationStatusPanel";

export default async function StudentVerifyPage() {
  const user = await getCurrentUser();

  if (!user) {
    return (
      <div className="min-h-screen bg-ink text-text-primary">
        <VerificationWizard />
      </div>
    );
  }

  if (user.role !== "STUDENT") {
    redirect("/student");
  }

  if (user.studentProfile?.verificationStatus === "VERIFIED") {
    redirect("/student/dashboard");
  }

  return (
    <div className="min-h-screen bg-ink text-text-primary">
      <VerificationStatusPanel
        status={user.studentProfile?.verificationStatus ?? "UNVERIFIED"}
        name={user.studentProfile?.fullLegalName ?? user.displayName}
        institution={user.studentProfile?.institution?.name ?? user.studentProfile?.institutionNameFreeText ?? ""}
        devControlsEnabled={process.env.ENABLE_DEV_VERIFICATION === "true" && process.env.NODE_ENV !== "production"}
      />
    </div>
  );
}
