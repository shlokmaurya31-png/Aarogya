import { describe, it, expect } from "vitest";
import { computeAvailable } from "./stockBalance";

describe("computeAvailable — available = onHand - reserved", () => {
  it("with no reservation, available equals on-hand", () => {
    expect(computeAvailable({ onHandQty: 100, reservedQty: 0 })).toBe(100);
  });

  it("a reservation reduces available without touching on-hand", () => {
    expect(computeAvailable({ onHandQty: 100, reservedQty: 30 })).toBe(70);
  });

  it("fully reserved stock has zero available", () => {
    expect(computeAvailable({ onHandQty: 50, reservedQty: 50 })).toBe(0);
  });
});
