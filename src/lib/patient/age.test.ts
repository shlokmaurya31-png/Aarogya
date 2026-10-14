import { describe, it, expect } from "vitest";
import { ageInYears, ageLabel, estimatedDobFromAge } from "./age";

describe("patient age from dob", () => {
  const now = new Date(2026, 9, 14);
  it("counts whole years, before and after the birthday", () => {
    expect(ageInYears(new Date(1990, 9, 14), now)).toBe(36);
    expect(ageInYears(new Date(1990, 9, 15), now)).toBe(35);
    expect(ageInYears("1990-01-01T00:00:00.000Z", now)).toBe(36);
  });
  it("is null without a dob", () => {
    expect(ageInYears(null, now)).toBeNull();
    expect(ageLabel({ dob: null }, now)).toBe("?");
  });
  it("marks an estimated dob", () => {
    expect(ageLabel({ dob: estimatedDobFromAge(34, now), dobEstimated: true }, now)).toBe("~34");
  });
  it("round-trips an age given at registration", () => {
    expect(ageInYears(estimatedDobFromAge(5, now), now)).toBe(5);
  });
});
