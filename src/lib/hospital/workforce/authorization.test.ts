import { describe, it, expect } from "vitest";
import { deriveExpiryState, CredentialAuthorizationError, requirePrivilege, requireCredential } from "./authorization";

/**
 * Phase B10 credential-aware authorization. These run against an in-memory
 * stand-in for the Prisma client rather than a database, so the predicate logic
 * — which is a security control — is covered by the normal test run and not
 * only by the PostgreSQL verification script.
 *
 * The regressions pinned here are the ones this gate found: selecting the first
 * ACTIVE/VERIFIED row and only then testing expiry, which denied a staff member
 * holding a renewed grant alongside its expired predecessor.
 */
const DAY = 86400_000;
const past = () => new Date(Date.now() - 30 * DAY);
const future = () => new Date(Date.now() + 365 * DAY);

type Row = Record<string, unknown>;
function fakeDb(opts: { staff?: Row | null; privileges?: Row[]; credentials?: Row[] }) {
  return {
    hospitalStaffProfile: { findUnique: async () => opts.staff ?? null },
    staffPrivilege: { findMany: async () => opts.privileges ?? [] },
    credential: { findMany: async () => opts.credentials ?? [] },
  } as never;
}

const ACTIVE_STAFF = { id: "s1", facilityId: "fA", status: "ACTIVE" };

describe("deriveExpiryState", () => {
  it("treats a null expiry as indefinitely active", () => {
    expect(deriveExpiryState(null)).toBe("ACTIVE");
  });
  it("derives expiry from the date even if a status column was never swept", () => {
    expect(deriveExpiryState(past())).toBe("EXPIRED");
  });
  it("flags an imminent expiry without denying it", () => {
    expect(deriveExpiryState(new Date(Date.now() + 5 * DAY))).toBe("EXPIRING_SOON");
    expect(deriveExpiryState(future())).toBe("ACTIVE");
  });
  it("treats the exact expiry instant as expired, not still valid", () => {
    const now = new Date();
    expect(deriveExpiryState(now, now)).toBe("EXPIRED");
  });
});

describe("requirePrivilege", () => {
  it("rejects a staff member from another facility before any privilege lookup", async () => {
    const db = fakeDb({ staff: { ...ACTIVE_STAFF, facilityId: "fB" }, privileges: [{ status: "ACTIVE", expiresAt: null }] });
    await expect(requirePrivilege(db, { staffId: "s1", facilityId: "fA", privilegeType: "X" }))
      .rejects.toMatchObject({ reason: "WRONG_FACILITY", status: 403 });
  });

  it("rejects an inactive staff member even when the privilege is active", async () => {
    const db = fakeDb({ staff: { ...ACTIVE_STAFF, status: "SUSPENDED" }, privileges: [{ status: "ACTIVE", expiresAt: null }] });
    await expect(requirePrivilege(db, { staffId: "s1", facilityId: "fA", privilegeType: "X" }))
      .rejects.toMatchObject({ reason: "INACTIVE_STAFF" });
  });

  it("rejects when no such privilege was ever granted", async () => {
    const db = fakeDb({ staff: ACTIVE_STAFF, privileges: [] });
    await expect(requirePrivilege(db, { staffId: "s1", facilityId: "fA", privilegeType: "X" }))
      .rejects.toMatchObject({ reason: "MISSING_PRIVILEGE" });
  });

  it("rejects a suspended privilege", async () => {
    const db = fakeDb({ staff: ACTIVE_STAFF, privileges: [{ status: "SUSPENDED", expiresAt: null }] });
    await expect(requirePrivilege(db, { staffId: "s1", facilityId: "fA", privilegeType: "X" }))
      .rejects.toMatchObject({ reason: "SUSPENDED_PRIVILEGE" });
  });

  it("rejects a revoked privilege", async () => {
    const db = fakeDb({ staff: ACTIVE_STAFF, privileges: [{ status: "REVOKED", expiresAt: null }] });
    await expect(requirePrivilege(db, { staffId: "s1", facilityId: "fA", privilegeType: "X" }))
      .rejects.toMatchObject({ reason: "REVOKED_PRIVILEGE" });
  });

  it("rejects an ACTIVE row whose expiry has passed", async () => {
    const db = fakeDb({ staff: ACTIVE_STAFF, privileges: [{ status: "ACTIVE", expiresAt: past() }] });
    await expect(requirePrivilege(db, { staffId: "s1", facilityId: "fA", privilegeType: "X" }))
      .rejects.toMatchObject({ reason: "EXPIRED_PRIVILEGE" });
  });

  it("accepts a current grant listed after an expired predecessor", async () => {
    const db = fakeDb({
      staff: ACTIVE_STAFF,
      privileges: [{ status: "ACTIVE", expiresAt: past() }, { status: "ACTIVE", expiresAt: future() }],
    });
    await expect(requirePrivilege(db, { staffId: "s1", facilityId: "fA", privilegeType: "X" })).resolves.toBeUndefined();
  });

  it("accepts a live grant that coexists with a revoked one", async () => {
    const db = fakeDb({
      staff: ACTIVE_STAFF,
      privileges: [{ status: "REVOKED", expiresAt: null }, { status: "ACTIVE", expiresAt: null }],
    });
    await expect(requirePrivilege(db, { staffId: "s1", facilityId: "fA", privilegeType: "X" })).resolves.toBeUndefined();
  });
});

describe("requireCredential", () => {
  it("rejects when the credential was never recorded", async () => {
    const db = fakeDb({ staff: ACTIVE_STAFF, credentials: [] });
    await expect(requireCredential(db, { staffId: "s1", facilityId: "fA", credentialType: "LICENSE" }))
      .rejects.toMatchObject({ reason: "MISSING_CREDENTIAL" });
  });

  it("rejects a recorded but unverified credential", async () => {
    const db = fakeDb({ staff: ACTIVE_STAFF, credentials: [{ status: "PENDING", expiresAt: null }] });
    await expect(requireCredential(db, { staffId: "s1", facilityId: "fA", credentialType: "LICENSE" }))
      .rejects.toMatchObject({ reason: "MISSING_CREDENTIAL" });
  });

  it("rejects a suspended or revoked credential", async () => {
    for (const status of ["SUSPENDED", "REVOKED"]) {
      const db = fakeDb({ staff: ACTIVE_STAFF, credentials: [{ status, expiresAt: null }] });
      await expect(requireCredential(db, { staffId: "s1", facilityId: "fA", credentialType: "LICENSE" }))
        .rejects.toMatchObject({ reason: "SUSPENDED_CREDENTIAL" });
    }
  });

  it("rejects a VERIFIED credential that has expired", async () => {
    const db = fakeDb({ staff: ACTIVE_STAFF, credentials: [{ status: "VERIFIED", expiresAt: past() }] });
    await expect(requireCredential(db, { staffId: "s1", facilityId: "fA", credentialType: "LICENSE" }))
      .rejects.toMatchObject({ reason: "EXPIRED_CREDENTIAL" });
  });

  it("accepts a renewed credential listed after its expired predecessor", async () => {
    const db = fakeDb({
      staff: ACTIVE_STAFF,
      credentials: [{ status: "VERIFIED", expiresAt: past() }, { status: "VERIFIED", expiresAt: future() }],
    });
    await expect(requireCredential(db, { staffId: "s1", facilityId: "fA", credentialType: "LICENSE" })).resolves.toBeUndefined();
  });
});

describe("CredentialAuthorizationError", () => {
  it("is a 403 that carries a reason code without leaking credential detail", () => {
    const e = new CredentialAuthorizationError("EXPIRED_CREDENTIAL", "Required credential has expired.");
    expect(e.status).toBe(403);
    expect(e.reason).toBe("EXPIRED_CREDENTIAL");
    expect(e.message).not.toMatch(/\d{4,}/); // no registration numbers or ids in the message
  });
});
