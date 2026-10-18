import { describe, expect, it } from "vitest";
import { parseDocumentDate } from "./merge";

describe("parseDocumentDate", () => {
  it("reads day-first and ISO dates only, and refuses impossible ones", () => {
    expect(parseDocumentDate("21/01/2026")?.toISOString().slice(0, 10)).toBe("2026-01-21");
    expect(parseDocumentDate("3-4-2026")?.toISOString().slice(0, 10)).toBe("2026-04-03");
    expect(parseDocumentDate("2026-02-05")?.toISOString().slice(0, 10)).toBe("2026-02-05");
    expect(parseDocumentDate("29/02/2028")?.toISOString().slice(0, 10)).toBe("2028-02-29");
    expect(parseDocumentDate("29/02/2026")).toBeNull();
    expect(parseDocumentDate("13/13/2026")).toBeNull();
    expect(parseDocumentDate("March 3, 2026")).toBeNull();
    expect(parseDocumentDate(undefined)).toBeNull();
  });
});
