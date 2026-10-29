import { describe, expect, it } from "vitest";
import { safeResponseJson, withApiErrors } from "./rbac";

describe("API responses never carry credential material", () => {
  it("serializes ordinary bodies unchanged", () => {
    const body = { a: 1, list: [{ user: { displayName: "Dr A" } }], when: new Date("2026-10-29T00:00:00Z") };
    expect(safeResponseJson(body)).toBe(JSON.stringify(body));
    expect(safeResponseJson(undefined)).toBe("null");
  });

  it("refuses a passwordHash at any depth", () => {
    expect(() => safeResponseJson({ passwordHash: "x" })).toThrow(/passwordHash/);
    expect(() => safeResponseJson({ encounters: [{ attendingStaff: { user: { displayName: "Dr A", passwordHash: "scrypt$…" } } }] })).toThrow(/passwordHash/);
  });

  it("withApiErrors answers 500 instead of sending one", async () => {
    const res = await withApiErrors(async () => ({ staff: { user: { passwordHash: "h" } } }));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("passwordHash");
    const ok = await withApiErrors(async () => ({ fine: true }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ fine: true });
  });
});
