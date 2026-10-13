import { redirectRetiredPrototype } from "@/lib/auth/retiredPrototype";

// The original /admin console (localStorage verification queue and staff
// accounts with plaintext passwords) is retired. Platform admins use
// /select-app → Scholar admin or Hospital OS. See retiredPrototype.ts.
export default async function RetiredAdminConsoleLayout(): Promise<never> {
  return redirectRetiredPrototype();
}
