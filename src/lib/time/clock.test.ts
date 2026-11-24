import { describe, expect, it } from "vitest";
import { testClockOffsetMs } from "./clock";

/** The test clock applies only against the local verify database; anywhere else the variable is ignored. */
describe("testClockOffsetMs", () => {
  const verify = "postgresql://aarogya:aarogya@localhost:5432/aarogya_verify";
  it("is zero without the variable", () => expect(testClockOffsetMs({ DATABASE_URL: verify })).toBe(0));
  it("applies against the local verify database", () => expect(testClockOffsetMs({ DATABASE_URL: verify, AAROGYA_TEST_CLOCK_OFFSET_MS: "-3600000" })).toBe(-3_600_000));
  it("is ignored against any other database", () => {
    for (const db of ["postgresql://u:p@localhost:5432/aarogya_dev", "postgresql://u:p@db.example.supabase.co:5432/aarogya_verify", "postgresql://u:p@staging.internal/aarogya", "not a url", undefined]) {
      expect(testClockOffsetMs({ DATABASE_URL: db, AAROGYA_TEST_CLOCK_OFFSET_MS: "3600000" })).toBe(0);
    }
  });
  it("refuses offsets over two days, and garbage", () => {
    expect(testClockOffsetMs({ DATABASE_URL: verify, AAROGYA_TEST_CLOCK_OFFSET_MS: String(3 * 86_400_000) })).toBe(0);
    expect(testClockOffsetMs({ DATABASE_URL: verify, AAROGYA_TEST_CLOCK_OFFSET_MS: "soon" })).toBe(0);
  });
});
