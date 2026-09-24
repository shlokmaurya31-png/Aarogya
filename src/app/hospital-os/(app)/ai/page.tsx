import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/getCurrentUser";
import { AiCockpit } from "@/components/hospital-os/AiCockpit";

export default async function HospitalOsAiCockpitPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/hospital-os/login");

  return (
    <AiCockpit
      role={user.role}
      displayName={user.displayName}
      facilityName={user.hospitalStaffProfile?.facility.name ?? "your facility"}
    />
  );
}
