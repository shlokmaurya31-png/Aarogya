import { beforeAll, describe, expect, it } from "vitest";
import { createResetToken, readResetToken, resetTokenMatches, RESET_TTL_MS } from "./passwordReset";

beforeAll(() => {
  process.env.AUTH_SECRET = "test-secret-for-password-reset-tokens-0000";
});

const user = { id: "user-1", passwordHash: "salt:hash-v1" };

describe("password reset tokens", () => {
  it("round-trips and matches the current password hash", () => {
    const token = createResetToken(user, 1000);
    const payload = readResetToken(token, 2000);
    expect(payload?.u).toBe("user-1");
    expect(resetTokenMatches(payload!, user.passwordHash)).toBe(true);
  });

  it("is single-use: stops matching once the password hash changes", () => {
    const payload = readResetToken(createResetToken(user, 0), 1)!;
    expect(resetTokenMatches(payload, "salt:hash-v2")).toBe(false);
  });

  it("expires", () => {
    const token = createResetToken(user, 0);
    expect(readResetToken(token, RESET_TTL_MS - 1)).not.toBeNull();
    expect(readResetToken(token, RESET_TTL_MS + 1)).toBeNull();
  });

  it("rejects tampered payloads and garbage", () => {
    const [, sig] = createResetToken(user, 0).split(".");
    const forged = Buffer.from(JSON.stringify({ u: "admin", e: 9e15, f: "x" })).toString("base64url");
    expect(readResetToken(`${forged}.${sig}`, 1)).toBeNull();
    expect(readResetToken("nonsense", 1)).toBeNull();
  });
});
