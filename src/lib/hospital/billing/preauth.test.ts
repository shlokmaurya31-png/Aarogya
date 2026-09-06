import { describe, it, expect } from "vitest";
import { isPreAuthStale } from "./preauth";

const d = (s: string) => new Date(s);

describe("isPreAuthStale", () => {
  it("is not stale immediately after request", () => {
    expect(isPreAuthStale({ status: "REQUESTED", requestedAt: d("2027-01-01") }, d("2027-01-01"), 7)).toBe(false);
  });

  it("is not stale just under the threshold", () => {
    expect(isPreAuthStale({ status: "REQUESTED", requestedAt: d("2027-01-01") }, d("2027-01-07T23:00:00Z"), 7)).toBe(false);
  });

  it("is stale once past the threshold", () => {
    expect(isPreAuthStale({ status: "REQUESTED", requestedAt: d("2027-01-01") }, d("2027-01-10"), 7)).toBe(true);
  });

  it("is never stale once decided (APPROVED), regardless of age", () => {
    expect(isPreAuthStale({ status: "APPROVED", requestedAt: d("2027-01-01") }, d("2027-06-01"), 7)).toBe(false);
  });

  it("is never stale once decided (DENIED), regardless of age", () => {
    expect(isPreAuthStale({ status: "DENIED", requestedAt: d("2027-01-01") }, d("2027-06-01"), 7)).toBe(false);
  });
});
