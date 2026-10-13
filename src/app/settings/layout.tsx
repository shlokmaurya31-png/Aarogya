import { redirectRetiredPrototype } from "@/lib/auth/retiredPrototype";

// Retired prototype route — see src/lib/auth/retiredPrototype.ts.
export default async function RetiredPrototypeLayout(): Promise<never> {
  return redirectRetiredPrototype();
}
