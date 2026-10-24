import { ForbiddenError, requireSession } from "@/lib/auth/rbac";

/** Week 5b routes: the caller's own patient login (households, proxies, members). */
export async function patientSession() {
  const s = await requireSession();
  if (s.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
  return s;
}
