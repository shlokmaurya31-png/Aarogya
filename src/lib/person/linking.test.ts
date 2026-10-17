import { describe, it, expect } from "vitest";
import { phoneUsable, PHONE_CONFIRMATION_MAX_AGE_MS, startInPersonVerification } from "./linking";

describe("phone codes need a phone confirmed within 12 months", () => {
  const now = new Date("2026-10-19T00:00:00Z");
  it("refuses a missing phone or a never-confirmed one", () => {
    expect(phoneUsable({ phone: null, phoneConfirmedAt: now }, undefined, now)).toBe(false);
    expect(phoneUsable({ phone: "9811122334", phoneConfirmedAt: null }, undefined, now)).toBe(false);
  });
  it("accepts up to 12 months, refuses after", () => {
    expect(phoneUsable({ phone: "9811122334", phoneConfirmedAt: new Date(now.getTime() - PHONE_CONFIRMATION_MAX_AGE_MS) }, undefined, now)).toBe(true);
    expect(phoneUsable({ phone: "9811122334", phoneConfirmedAt: new Date(now.getTime() - PHONE_CONFIRMATION_MAX_AGE_MS - 1) }, undefined, now)).toBe(false);
  });
});

describe("a phone staff set or changed can't take a link code during the hold (insider-takeover fix)", () => {
  const now = new Date("2026-10-20T00:00:00Z");
  const day = 86_400_000;
  const p = (setDaysAgo: number) => ({ phone: "9811122334", phoneConfirmedAt: new Date(now.getTime() - setDaysAgo * day), phoneSetByStaffAt: new Date(now.getTime() - setDaysAgo * day) });
  it("refuses within the default 7 days, allows after", () => {
    expect(phoneUsable(p(6.9), undefined, now)).toBe(false);
    expect(phoneUsable(p(7), undefined, now)).toBe(true);
  });
  it("uses the facility's hold", () => {
    expect(phoneUsable(p(10), 14 * day, now)).toBe(false);
    expect(phoneUsable(p(10), 0, now)).toBe(true);
  });
});

describe("in-person ID verification stores the last 4 characters only", () => {
  const base = { facilityId: "f", requestId: "r", staffId: "s", byUserId: "u", idType: "AADHAAR", reason: "NO_PHONE_ON_RECORD" };
  it.each(["123456789012", "1234 5678 9012", "12345", "123", "12-4", ""])("refuses %j before touching the database", async (idLast4) => {
    await expect(startInPersonVerification({ ...base, idLast4 })).rejects.toThrow(/last 4 characters/);
  });
  it("refuses an unknown ID type or reason", async () => {
    await expect(startInPersonVerification({ ...base, idType: "RATION_CARD", idLast4: "1234" })).rejects.toThrow(/idType/);
    await expect(startInPersonVerification({ ...base, reason: "BECAUSE", idLast4: "1234" })).rejects.toThrow(/reason/);
  });
});
