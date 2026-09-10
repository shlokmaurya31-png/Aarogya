import { prisma } from "@/lib/db";
import { getStaffingCoverage } from "@/lib/hospital/workforce/service";

/**
 * Workforce Command Center (Phase B10) — every count is a live, facility-scoped,
 * indexed DB query. Credential/privilege expiry is derived from dates at read
 * time (no scheduler mutating rows). No fabricated metrics.
 */
export async function getWorkforceCommandCenter(facilityId: string) {
  const now = new Date();
  const soon = new Date(now.getTime() + 30 * 24 * 3600_000);
  const shiftHorizon = new Date(now.getTime() + 7 * 24 * 3600_000);

  const [
    staffActive, staffInactive, availAvailable, availOnLeave, availUnavailable, availSuspended,
    upcomingShifts, credExpiringSoon, credExpired, credSuspendedRevoked, privActive, privExpiringSoon, privSuspendedRevoked,
    activeAssignments,
  ] = await Promise.all([
    prisma.hospitalStaffProfile.count({ where: { facilityId, status: "ACTIVE" } }),
    prisma.hospitalStaffProfile.count({ where: { facilityId, status: { in: ["INACTIVE", "SUSPENDED"] } } }),
    prisma.staffAvailability.count({ where: { facilityId, availability: "AVAILABLE" } }),
    prisma.staffAvailability.count({ where: { facilityId, availability: "ON_LEAVE" } }),
    prisma.staffAvailability.count({ where: { facilityId, availability: { in: ["UNAVAILABLE", "OFF_DUTY"] } } }),
    prisma.staffAvailability.count({ where: { facilityId, availability: "SUSPENDED" } }),
    prisma.staffShift.count({ where: { facilityId, status: "SCHEDULED", startAt: { gte: now, lte: shiftHorizon } } }),
    // Derived expiry: VERIFIED but expiring within 30 days, and past-expiry not yet swept.
    prisma.credential.count({ where: { facilityId, status: "VERIFIED", expiresAt: { not: null, gt: now, lte: soon } } }),
    prisma.credential.count({ where: { facilityId, OR: [{ status: "EXPIRED" }, { status: "VERIFIED", expiresAt: { not: null, lte: now } }] } }),
    prisma.credential.count({ where: { facilityId, status: { in: ["SUSPENDED", "REVOKED"] } } }),
    prisma.staffPrivilege.count({ where: { facilityId, status: "ACTIVE", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } }),
    prisma.staffPrivilege.count({ where: { facilityId, status: "ACTIVE", expiresAt: { not: null, gt: now, lte: soon } } }),
    prisma.staffPrivilege.count({ where: { facilityId, status: { in: ["SUSPENDED", "REVOKED"] } } }),
    prisma.workforceAssignment.groupBy({ by: ["departmentId"], where: { facilityId, status: "ACTIVE" }, _count: { _all: true } }),
  ]);

  const coverage = await getStaffingCoverage(facilityId);
  const uncoveredRequirements = coverage.filter((c) => c.shortfall > 0).length;

  return {
    staff: { active: staffActive, inactive: staffInactive },
    availability: { available: availAvailable, onLeave: availOnLeave, unavailable: availUnavailable, suspended: availSuspended },
    shifts: { upcoming: upcomingShifts },
    credentials: { expiringSoon: credExpiringSoon, expired: credExpired, suspendedRevoked: credSuspendedRevoked },
    privileges: { active: privActive, expiringSoon: privExpiringSoon, suspendedRevoked: privSuspendedRevoked },
    staffing: { uncoveredRequirements, requirements: coverage.length },
    assignmentsByDepartment: activeAssignments.map((a) => ({ departmentId: a.departmentId, count: a._count._all })),
  };
}
