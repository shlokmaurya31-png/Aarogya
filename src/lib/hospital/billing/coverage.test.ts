import { describe, it, expect } from "vitest";
import { isCoverageValid } from "./coverage";

const d = (s: string) => new Date(s);

describe("isCoverageValid", () => {
  it("is valid on the exact validFrom boundary", () => {
    expect(isCoverageValid({ status: "ACTIVE", validFrom: d("2027-01-01"), validTo: null }, d("2027-01-01"))).toBe(true);
  });

  it("is invalid before validFrom (future coverage)", () => {
    expect(isCoverageValid({ status: "ACTIVE", validFrom: d("2027-06-01"), validTo: null }, d("2027-01-01"))).toBe(false);
  });

  it("is invalid on or after validTo (expired coverage)", () => {
    expect(isCoverageValid({ status: "ACTIVE", validFrom: d("2027-01-01"), validTo: d("2027-02-01") }, d("2027-02-01"))).toBe(false);
  });

  it("is valid just before validTo", () => {
    expect(isCoverageValid({ status: "ACTIVE", validFrom: d("2027-01-01"), validTo: d("2027-02-01") }, d("2027-01-31"))).toBe(true);
  });

  it("is invalid when status is not ACTIVE, regardless of dates", () => {
    expect(isCoverageValid({ status: "INACTIVE", validFrom: d("2027-01-01"), validTo: null }, d("2027-01-15"))).toBe(false);
    expect(isCoverageValid({ status: "EXPIRED", validFrom: d("2027-01-01"), validTo: null }, d("2027-01-15"))).toBe(false);
  });

  it("is valid indefinitely when validTo is null", () => {
    expect(isCoverageValid({ status: "ACTIVE", validFrom: d("2020-01-01"), validTo: null }, d("2030-01-01"))).toBe(true);
  });
});
