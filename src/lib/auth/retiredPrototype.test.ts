import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The retired prototype URLs (/dashboard, /lab, /hospital, ...) only redirect
 * through the real session: patients to /patient, doctors to their
 * workspace, other roles to their portal, everyone else to /login.
 */
const redirect = vi.fn((url: string) => {
  throw Object.assign(new Error("NEXT_REDIRECT"), { url });
});
const getCurrentUser = vi.fn();
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));
vi.mock("./getCurrentUser", () => ({ getCurrentUser: () => getCurrentUser() }));

const { redirectRetiredPrototype } = await import("./retiredPrototype");

async function destination(): Promise<string> {
  try {
    await redirectRetiredPrototype();
  } catch (err) {
    return (err as { url: string }).url;
  }
  throw new Error("expected a redirect");
}

describe("retired prototype redirect", () => {
  beforeEach(() => { redirect.mockClear(); getCurrentUser.mockReset(); });

  it("sends a signed-out visitor to /login", async () => {
    getCurrentUser.mockResolvedValue(null);
    expect(await destination()).toBe("/login");
  });
  it("sends a patient to /patient", async () => {
    getCurrentUser.mockResolvedValue({ id: "u1", role: "PATIENT" });
    expect(await destination()).toBe("/patient");
  });
  it("sends a doctor to the doctor workspace", async () => {
    getCurrentUser.mockResolvedValue({ id: "u2", role: "DOCTOR" });
    expect(await destination()).toBe("/hospital-os/doctor");
  });
  it("sends other hospital staff to their normal portal", async () => {
    getCurrentUser.mockResolvedValue({ id: "u3", role: "NURSE" });
    expect(await destination()).toBe("/hospital-os");
  });
});
