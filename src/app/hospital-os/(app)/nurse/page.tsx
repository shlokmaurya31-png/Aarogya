import { NurseTasks } from "@/components/hospital-os/NurseTasks";
import { getCurrentUser } from "@/lib/auth/getCurrentUser";

export default async function HospitalOsNursePage() {
  const user = await getCurrentUser();
  return <NurseTasks staffId={user?.hospitalStaffProfile?.id} />;
}
