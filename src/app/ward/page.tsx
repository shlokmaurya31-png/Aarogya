import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/getCurrentUser";
import { roleHasPermission } from "@/lib/auth/permissions";
import { WardApp } from "@/components/ward/WardApp";

/**
 * Flagship 4c — the ward device app: for staff who give medicines (the nurse signed in on the shared tablet).
 * Flagship 5b: the page carries no personal name. The tablet's service worker keeps a copy of it for offline
 * use, so the nurse's name is fetched after sign-in and held in memory only.
 */
export default async function WardPage() {
  const user = await getCurrentUser();
  if (!user || !user.hospitalStaffProfile || !roleHasPermission(user.role, "medication:administer")) redirect("/hospital-os/login");
  return <WardApp />;
}
