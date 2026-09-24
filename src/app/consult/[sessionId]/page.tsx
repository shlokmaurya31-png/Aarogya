import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/getCurrentUser";
import { ConsultSession } from "@/components/hospital-os/ConsultSession";

const CLINICIAN_ROLES = new Set([
  "DOCTOR", "NURSE", "HOSPITAL_ADMIN", "AAROGYA_ADMIN",
  "LAB_TECHNICIAN", "RADIOLOGY_TECH", "PHARMACIST", "BILLING_STAFF", "FRONT_DESK",
]);

/**
 * Standalone consult session view (not inside the Hospital OS shell). Guarded:
 * only a signed-in clinician can reach it; anyone else is sent to the login.
 * The session itself is further gated server-side (the doctor must own the
 * ACTIVE access session — see the patient-access API).
 */
export default async function StandaloneConsultPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const user = await getCurrentUser();
  if (!user || !CLINICIAN_ROLES.has(user.role)) redirect("/patient-login");

  const { sessionId } = await params;
  return (
    <div className="min-h-screen bg-surface px-4 py-6 text-text-primary sm:px-6 lg:px-8">
      <ConsultSession sessionId={sessionId} />
    </div>
  );
}
