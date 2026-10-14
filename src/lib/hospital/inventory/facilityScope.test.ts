import { describe, it, expect } from "vitest";
import { ConflictError } from "@/lib/auth/rbac";
import { assertReplayInFacility } from "./facilityScope";

describe("assertReplayInFacility", () => {
  it("returns the row when the replayed key belongs to the caller's facility", () => {
    const row = { id: "t1", facilityId: "fac-a" };
    expect(assertReplayInFacility(row, "fac-a")).toBe(row);
  });

  it("refuses (409) a key whose row belongs to another facility, never returning it", () => {
    expect(() => assertReplayInFacility({ id: "t1", facilityId: "fac-b" }, "fac-a")).toThrow(ConflictError);
  });
});
