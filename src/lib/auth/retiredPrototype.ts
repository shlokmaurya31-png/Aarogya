import { redirect } from "next/navigation";
import { getCurrentUser } from "./getCurrentUser";
import { resolveLoginDestination } from "./roleDestination";

/**
 * The original prototype (/dashboard, /lab, /hospital, /settings,
 * /onboarding, /prescriptions, the /admin console) ran on a client-only
 * Zustand "login" that accepted any email, over mock data. It has been
 * removed. Its URLs only redirect through the REAL session, so old links
 * and bookmarks still land somewhere sensible:
 *   - patients → /patient
 *   - doctors  → /hospital-os/doctor (their workspace)
 *   - every other signed-in role → its normal portal (resolveLoginDestination)
 *   - signed out → /login
 */
export async function redirectRetiredPrototype(): Promise<never> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  redirect(user.role === "DOCTOR" ? "/hospital-os/doctor" : resolveLoginDestination(user.role));
}
