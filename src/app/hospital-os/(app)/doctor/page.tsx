import { DoctorWorkspace } from "@/components/hospital-os/DoctorWorkspace";
import { WorkPhones } from "@/components/hospital-os/WorkPhones";
import { getCurrentUser } from "@/lib/auth/getCurrentUser";

export default async function HospitalOsDoctorPage() {
  const user = await getCurrentUser();
  return (
    <div className="space-y-4">
      <DoctorWorkspace staffId={user?.hospitalStaffProfile?.id} />
      <WorkPhones />
    </div>
  );
}
