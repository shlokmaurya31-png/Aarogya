import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/getCurrentUser";
import { HospitalShell } from "@/components/hospital-os/HospitalShell";

const HOSPITAL_ROLES = new Set(["HOSPITAL_ADMIN", "DOCTOR", "NURSE", "LAB_TECHNICIAN", "RADIOLOGY_TECH", "PHARMACIST", "BILLING_STAFF", "AAROGYA_ADMIN"]);

export default async function HospitalOsLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();

  if (!user || !HOSPITAL_ROLES.has(user.role)) {
    redirect("/hospital-os/login");
  }
  if (user.role !== "AAROGYA_ADMIN" && !user.hospitalStaffProfile) {
    redirect("/hospital-os/login");
  }

  return (
    <HospitalShell
      displayName={user.displayName}
      displayRole={user.hospitalStaffProfile?.displayRole ?? "Platform Admin"}
      facilityName={user.hospitalStaffProfile?.facility.name ?? "All facilities"}
      role={user.role}
    >
      {children}
    </HospitalShell>
  );
}
