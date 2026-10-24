import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { samePhone, verifiedLoginPhones } from "@/lib/auth/loginPhones";
import { resolvePatientIdsForRead } from "@/lib/patient/merge";

/**
 * Week 5a — a doctor who is also a patient (decision: a separate DoctorProfile
 * and Person, never joined). Nothing links the two rows. To keep a doctor out
 * of their own record through doctor tools, the resolvers ask, at the moment
 * of access, whether the doctor's login and the person's account are the same
 * human: the same verified contact, i.e. the login's email equals the
 * person's owner email or a verified email contact, or (5b follow-up) a phone
 * ever verified on the login (src/lib/auth/loginPhones.ts) equals one of the
 * person's verified phones. A match refuses (404-shaped), and nothing about
 * the match is stored or shown.
 */
export async function isSameHuman(doctor: { userId: string }, personId: string | null): Promise<boolean> {
  if (!personId) return false;
  const doctorUser = await prisma.user.findUnique({ where: { id: doctor.userId }, select: { email: true } });
  if (!doctorUser) return false;
  const email = doctorUser.email.trim().toLowerCase();
  const owner = await prisma.personAccount.findFirst({ where: { personId, role: "OWNER" }, select: { user: { select: { email: true } } } });
  if (owner?.user.email.trim().toLowerCase() === email) return true;
  const contacts = await prisma.personContact.findMany({ where: { personId, status: "ACTIVE", verifiedAt: { not: null } }, select: { kind: true, value: true } });
  if (contacts.some((c) => c.kind === "EMAIL" && c.value.trim().toLowerCase() === email)) return true;
  const phones = contacts.filter((c) => c.kind === "PHONE");
  if (!phones.length) return false;
  const mine = await verifiedLoginPhones(doctor.userId);
  return phones.some((c) => mine.some((p) => samePhone(p, c.value)));
}

/** For a staff actor: are they a doctor reading their own person-level record? */
export async function staffIsSubject(actorUserId: string, personId: string | null): Promise<boolean> {
  if (!personId) return false;
  const d = await prisma.doctorProfile.findUnique({ where: { userId: actorUserId }, select: { userId: true } });
  return d ? isSameHuman(d, personId) : false;
}

/** Where a staff member read a facility chart (the self-access report shows it). */
export type ChartSurface = "PATIENT" | "CHART" | "SUMMARY" | "TIMELINE";

/**
 * 5b follow-up — a staff member reading their own chart at their own
 * facility, as that facility's staff, is allowed (they may be treating there)
 * but recorded: an audit row security.selfAccess (accessKind SELF_ACCESS),
 * listed in the facility's self-access report for admins. "Their own" means
 * the chart's Person (an ACTIVE link of the record or a record merged into it)
 * is the same human as the staff login (isSameHuman). Returns whether it was.
 */
export async function noteStaffChartRead(actor: { userId: string; facilityId: string }, patientId: string, surface: ChartSurface): Promise<boolean> {
  const ids = await resolvePatientIdsForRead(patientId);
  const links = await prisma.personPatientLink.findMany({ where: { patientId: { in: ids }, status: "ACTIVE" }, select: { personId: true } });
  for (const personId of new Set(links.map((l) => l.personId))) {
    if (await isSameHuman({ userId: actor.userId }, personId)) {
      await recordAuditEvent("security.selfAccess", actor.userId, { accessKind: "SELF_ACCESS", surface }, { facilityId: actor.facilityId, patientId });
      return true;
    }
  }
  return false;
}

/** The facility's self-access report: who read their own chart, where and when (newest first), and a count per staff member. */
export async function selfAccessReport(facilityId: string, sinceDays = 30) {
  const since = new Date(Date.now() - Math.min(Math.max(sinceDays, 1), 365) * 86_400_000);
  const rows = await prisma.auditEvent.findMany({ where: { type: "security.selfAccess", facilityId, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 500, select: { userId: true, patientId: true, createdAt: true, detail: true } });
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId).filter((x): x is string => !!x))] } }, select: { id: true, displayName: true, role: true } });
  const patients = await prisma.patient.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.patientId).filter((x): x is string => !!x))] } }, select: { id: true, uhid: true } });
  const byStaff = new Map<string, number>();
  for (const r of rows) if (r.userId) byStaff.set(r.userId, (byStaff.get(r.userId) ?? 0) + 1);
  const name = (id: string | null) => users.find((u) => u.id === id);
  return {
    windowDays: sinceDays,
    total: rows.length,
    byStaff: [...byStaff.entries()].sort((a, b) => b[1] - a[1]).map(([userId, count]) => ({ userId, name: name(userId)?.displayName ?? "Unknown", role: name(userId)?.role ?? null, count })),
    entries: rows.map((r) => ({ userId: r.userId, name: name(r.userId)?.displayName ?? "Unknown", uhid: patients.find((p) => p.id === r.patientId)?.uhid ?? null, surface: (r.detail as { surface?: string } | null)?.surface ?? null, at: r.createdAt.toISOString() })),
  };
}
