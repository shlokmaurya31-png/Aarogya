import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/getCurrentUser";
import { PatientShell } from "@/components/patient-portal/PatientShell";

export default async function PatientAppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user || user.role !== "PATIENT") {
    redirect("/patient/login");
  }

  return <PatientShell displayName={user.displayName}>{children}</PatientShell>;
}
