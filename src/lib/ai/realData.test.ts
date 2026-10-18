import { describe, it, expect } from "vitest";
import { realDataEnabled } from "./realData";

describe("the real-data switch is off unless explicitly on", () => {
  it("is off by default and for anything but 'true'", () => {
    expect(realDataEnabled({})).toBe(false);
    for (const v of ["1", "yes", "TRUE", "on", ""]) expect(realDataEnabled({ AI_REAL_DATA_ENABLED: v })).toBe(false);
  });
  it("is on only for 'true'", () => expect(realDataEnabled({ AI_REAL_DATA_ENABLED: "true" })).toBe(true));
});
