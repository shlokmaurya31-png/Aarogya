import { describe, it, expect } from "vitest";
import { computeReorderState } from "./reorder";

describe("computeReorderState — surfaces the signal only, never auto-purchases", () => {
  it("stock at or below the reorder point is flagged", () => {
    expect(computeReorderState("item-1", 10, 10, 50).belowReorderPoint).toBe(true);
    expect(computeReorderState("item-1", 5, 10, 50).belowReorderPoint).toBe(true);
  });

  it("stock above the reorder point is not flagged", () => {
    expect(computeReorderState("item-1", 20, 10, 50).belowReorderPoint).toBe(false);
  });

  it("an item with no reorder point configured is never flagged", () => {
    expect(computeReorderState("item-1", 0, null, null).belowReorderPoint).toBe(false);
  });
});
