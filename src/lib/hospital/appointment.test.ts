import { describe, it, expect } from "vitest";
import { appointmentsOverlap } from "./appointment";

const t = (hm: string) => new Date(`2026-09-10T${hm}:00`);

describe("appointmentsOverlap — interval conflict matrix (Phase 5.5)", () => {
  it("flags an exact duplicate slot as overlapping", () => {
    expect(appointmentsOverlap(t("09:00"), t("09:30"), t("09:00"), t("09:30"))).toBe(true);
  });

  it("flags a partial overlap at the start of the new slot", () => {
    // existing 09:00-09:30, new 08:45-09:15
    expect(appointmentsOverlap(t("08:45"), t("09:15"), t("09:00"), t("09:30"))).toBe(true);
  });

  it("flags a partial overlap at the end of the new slot", () => {
    // existing 09:00-09:30, new 09:15-09:45
    expect(appointmentsOverlap(t("09:15"), t("09:45"), t("09:00"), t("09:30"))).toBe(true);
  });

  it("flags a new slot fully contained within an existing one", () => {
    // existing 09:00-10:00, new 09:15-09:45
    expect(appointmentsOverlap(t("09:15"), t("09:45"), t("09:00"), t("10:00"))).toBe(true);
  });

  it("flags a new slot fully containing an existing one", () => {
    // existing 09:15-09:45, new 09:00-10:00
    expect(appointmentsOverlap(t("09:00"), t("10:00"), t("09:15"), t("09:45"))).toBe(true);
  });

  it("does NOT flag two slots that merely touch at the boundary (adjacent, not overlapping)", () => {
    // existing 09:00-09:30, new 09:30-10:00 — back-to-back is legal
    expect(appointmentsOverlap(t("09:30"), t("10:00"), t("09:00"), t("09:30"))).toBe(false);
  });

  it("does NOT flag two slots that touch at the other boundary", () => {
    // existing 09:30-10:00, new 09:00-09:30
    expect(appointmentsOverlap(t("09:00"), t("09:30"), t("09:30"), t("10:00"))).toBe(false);
  });

  it("does NOT flag two entirely disjoint slots", () => {
    expect(appointmentsOverlap(t("09:00"), t("09:30"), t("14:00"), t("14:30"))).toBe(false);
  });

  it("flags a reschedule-into-conflict shape (new slot overlaps a third, unrelated existing booking)", () => {
    // Rescheduling into 10:00-10:30 while another booking already holds 10:15-10:45
    expect(appointmentsOverlap(t("10:00"), t("10:30"), t("10:15"), t("10:45"))).toBe(true);
  });
});

// Note: doctor/facility/status scoping (different doctor, different
// facility, and CANCELLED/NO_SHOW/COMPLETED exclusion) is not re-tested
// here — appointmentsOverlap is a pure interval predicate, and that
// scoping lives entirely in bookAppointment's Prisma where-clause
// (doctorStaffId equality, facilityId isolation via the resolved
// appointment's own facilityId, status notIn filter), verified instead by
// scripts/verify-postgres-appointment-concurrency.ts against a real DB.
