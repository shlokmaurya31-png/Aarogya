import { redirect } from "next/navigation";

/**
 * /hospital was a client-only prototype (Zustand/localStorage mock, no
 * real auth, no real data) that predates Hospital OS. The canonical,
 * real production hospital application is /hospital-os. This route is
 * kept (not deleted) but now redirects there instead of rendering the
 * mock.
 */
export default function HospitalLegacyRedirect() {
  redirect("/hospital-os/login");
}
