import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  hospitalStaffProfile: { findUnique: vi.fn(), count: vi.fn() },
  credential: { findMany: vi.fn() },
  staffPrivilege: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));

import { enforceLicensure } from "./licensure";

const ctx = { staff: { id: "s1" }, facilityId: "f1" };
const day = 24 * 3600_000;

beforeEach(() => {
  vi.resetAllMocks();
  db.hospitalStaffProfile.findUnique.mockResolvedValue({ id: "s1", status: "ACTIVE" });
  db.hospitalStaffProfile.count.mockResolvedValue(1); // an ACTIVE membership at f1 (D8)
});

describe("enforceLicensure", () => {
  it("allows prescribing with a verified, unexpired registration", async () => {
    db.credential.findMany.mockResolvedValue([{ status: "VERIFIED", expiresAt: new Date(Date.now() + day) }]);
    await expect(enforceLicensure(ctx, "prescribe")).resolves.toBeUndefined();
    expect(db.credential.findMany).toHaveBeenCalledWith({ where: { staffId: "s1", facilityId: "f1", credentialType: "REGISTRATION" } });
  });

  it("blocks prescribing once the registration has expired", async () => {
    db.credential.findMany.mockResolvedValue([{ status: "VERIFIED", expiresAt: new Date(Date.now() - day) }]);
    await expect(enforceLicensure(ctx, "prescribe")).rejects.toMatchObject({ status: 403, reason: "EXPIRED_CREDENTIAL" });
  });

  it("blocks with no credential on file", async () => {
    db.credential.findMany.mockResolvedValue([]);
    await expect(enforceLicensure(ctx, "dispense")).rejects.toMatchObject({ reason: "MISSING_CREDENTIAL" });
  });

  it("checks the facility privilege for sign-off actions", async () => {
    db.staffPrivilege.findMany.mockResolvedValue([]);
    await expect(enforceLicensure(ctx, "labResultRelease")).rejects.toMatchObject({ reason: "MISSING_PRIVILEGE" });
    expect(db.staffPrivilege.findMany).toHaveBeenCalledWith({ where: { staffId: "s1", facilityId: "f1", privilegeType: "LAB_RESULT_VERIFY" } });
  });

  it("exempts AAROGYA_ADMIN (no staff profile)", async () => {
    await expect(enforceLicensure({ staff: null, facilityId: "f1" }, "prescribe")).resolves.toBeUndefined();
    expect(db.hospitalStaffProfile.findUnique).not.toHaveBeenCalled();
  });
});
