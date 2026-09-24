import { getCurrentUser } from "@/lib/auth/getCurrentUser";
import { NeuralAccessLogin } from "@/components/ui/neural-access-login";

const CLINICIAN_ROLES = new Set([
  "DOCTOR", "NURSE", "HOSPITAL_ADMIN", "AAROGYA_ADMIN",
  "LAB_TECHNICIAN", "RADIOLOGY_TECH", "PHARMACIST", "BILLING_STAFF", "FRONT_DESK",
]);

/**
 * Standalone, self-contained "Neural Access" patient login. Not part of the
 * Hospital OS shell. If a clinician is already signed in we skip to the code
 * step; otherwise they authenticate here first (patients are rejected).
 */
export default async function StandalonePatientLoginPage() {
  const user = await getCurrentUser();
  const authed = Boolean(user && CLINICIAN_ROLES.has(user.role));
  return <NeuralAccessLogin authed={authed} displayName={authed ? user!.displayName : undefined} />;
}
