/**
 * A student's name lives on their User: legalName (as on their documents) and
 * displayName (what they prefer to be called). StudentProfile holds no name.
 */
export function studentNames(user: { legalName: string | null; displayName: string }) {
  return { fullLegalName: user.legalName ?? user.displayName, preferredName: user.displayName };
}
