import { describe, expect, it } from "vitest";
import { isSignInPath, localKeysToClear } from "./clearCaches";

describe("logout clears the browser's storage (Flagship 5c)", () => {
  it("keeps only the device's theme and language", () => {
    expect(localKeysToClear(["aarogya-theme", "aarogya-language", "draft:patient-123", "nextjs-cache", "aarogya-ward"])).toEqual(["draft:patient-123", "nextjs-cache", "aarogya-ward"]);
  });
  it("knows the sign-in pages, where an expired session lands", () => {
    expect(["/login", "/patient-login", "/patient/login", "/hospital-os/login"].every(isSignInPath)).toBe(true);
    expect(isSignInPath("/patient")).toBe(false);
  });
});
