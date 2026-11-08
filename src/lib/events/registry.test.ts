import { describe, expect, it, vi } from "vitest";

/** Flagship 2b: the dispatcher's registry check, on fresh module instances. */
describe("the declared consumer registry", () => {
  it("refuses before the registry module is loaded, and while any of it is missing", async () => {
    vi.resetModules();
    const c = await import("./consumers");
    expect(() => c.assertRegistryComplete()).toThrow(/not loaded/);
    c.declareConsumerRegistry([{ name: "observability-projection", handles: "*" }, { name: "a", handles: ["X"] }, { name: "b", handles: ["Y"] }]);
    expect(() => c.assertRegistryComplete()).toThrow(/a, b/);
    c.registerConsumer({ name: "a", handles: ["X"], handle: async () => {} });
    expect(() => c.assertRegistryComplete()).toThrow(/\bb\b/);
    c.registerConsumer({ name: "b", handles: ["Y"], handle: async () => {} });
    const reg = c.assertRegistryComplete();
    expect(c.requiredConsumersFor("X", reg)).toEqual(["observability-projection", "a"]);
    expect(c.requiredConsumersFor("Z", reg)).toEqual(["observability-projection"]);
  });

  it("the runner's registry declares exactly its list, and registering it completes it", async () => {
    vi.resetModules();
    const r = await import("@/lib/runner/consumers");
    const c = await import("./consumers");
    expect(c.declaredConsumerRegistry()?.map((x) => x.name).sort()).toEqual([...r.EXPECTED_CONSUMERS].sort());
    c.resetConsumers();
    expect(() => c.assertRegistryComplete()).toThrow(/refusing to dispatch/);
    expect(r.registerAllConsumers().sort()).toEqual([...r.EXPECTED_CONSUMERS].sort());
    expect(() => c.assertRegistryComplete()).not.toThrow();
  });
});
