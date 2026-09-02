import { DoctorWorkspace } from "@/components/hospital-os/DoctorWorkspace";
import { getCurrentUser } from "@/lib/auth/getCurrentUser";

export default async function HospitalOsDoctorPage() {
  const user = await getCurrentUser();
  return <DoctorWorkspace staffId={user?.hospitalStaffProfile?.id} />;
}
