import type { Role } from "@prisma/client";

/**
 * Where to send a user right after a successful sign-in, based on the
 * `role` the server's own login response returned — never a client guess,
 * URL param, or submitted value. This is UX routing only, not a security
 * boundary: every destination below independently re-verifies
 * authorization server-side (getCurrentUser()/requireSession() +
 * per-layout role checks), completely unchanged by this function.
 */
export function resolveLoginDestination(role: Role): string {
  switch (role) {
    case "PATIENT":
      return "/patient";
    case "STUDENT":
      return "/student";
    case "EDUCATOR":
      return "/educator";
    case "DOCTOR":
    case "NURSE":
    case "LAB_TECHNICIAN":
    case "RADIOLOGY_TECH":
    case "PHARMACIST":
    case "BILLING_STAFF":
    case "FRONT_DESK":
    case "HOSPITAL_ADMIN":
      return "/hospital-os";
    case "AAROGYA_ADMIN":
      return "/select-app";
    default:
      // INSTITUTION_ADMIN has no built destination yet — land safely on
      // home rather than error.
      return "/";
  }
}
