import { describe, expect, it } from "vitest";
import { samePhone } from "./loginPhones";

describe("samePhone (the same-human check's phone match)", () => {
  it("matches one Indian mobile number however it was written", () => {
    expect(samePhone("+919876543210", "98765 43210")).toBe(true);
    expect(samePhone("919876543210", "+91-98765-43210")).toBe(true);
  });
  it("doesn't match different numbers or fragments", () => {
    expect(samePhone("+919876543210", "+919876543211")).toBe(false);
    expect(samePhone("43210", "43210")).toBe(false);
  });
});
