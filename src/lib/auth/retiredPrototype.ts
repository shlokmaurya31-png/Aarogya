import { redirect } from "next/navigation";
import { getCurrentUser } from "./getCurrentUser";
import { resolveLoginDestination } from "./roleDestination";

/**
 * The original prototype (/dashboard, /lab, /hospital, /settings,
 * /onboarding, /prescriptions, /admin console) ran on a client-only
 * localStorage "login" that accepted any email, over mock data. It is
 * retired: its routes now resolve through the REAL session — signed-in users
 * land in their real portal, everyone else at /login. The page code is kept
 * (not deleted) but is no longer reachable.
 */
export async function redirectRetiredPrototype(): Promise<never> {
  const user = await getCurrentUser();
  redirect(user ? resolveLoginDestination(user.role) : "/login");
}
