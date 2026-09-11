import { describe, it, expect } from "vitest";
import { getAbdmConfig, checkEnvironmentSafety, describeAbdmConfig, ABDM_ENV_VARS } from "./config";
import { AbdmAdapter, AbdmRegistryAdapter, getExchangeAdapter } from "./adapters/abdm";

/**
 * Phase C1 — configuration must FAIL CLOSED and adapters must never fake
 * connectivity. These are the tests that keep the product honest: if they ever
 * pass while an adapter returns a fabricated success, the whole "ABDM-ready"
 * claim becomes a lie.
 */

const FULL = {
  [ABDM_ENV_VARS.environment]: "SANDBOX",
  [ABDM_ENV_VARS.baseUrl]: "https://sandbox.example",
  [ABDM_ENV_VARS.clientId]: "client-1",
  [ABDM_ENV_VARS.clientSecret]: "shhh",
};

describe("getAbdmConfig", () => {
  it("defaults to DISABLED when nothing is configured", () => {
    const c = getAbdmConfig({});
    expect(c.environment).toBe("DISABLED");
    expect(c.configured).toBe(false);
  });

  it("treats an unrecognised environment as DISABLED rather than guessing", () => {
    expect(getAbdmConfig({ [ABDM_ENV_VARS.environment]: "prod" }).environment).toBe("DISABLED");
    expect(getAbdmConfig({ [ABDM_ENV_VARS.environment]: "" }).environment).toBe("DISABLED");
  });

  it("reports exactly which variables are missing", () => {
    const c = getAbdmConfig({ [ABDM_ENV_VARS.environment]: "SANDBOX" });
    expect(c.configured).toBe(false);
    expect(c.missing).toEqual([ABDM_ENV_VARS.baseUrl, ABDM_ENV_VARS.clientId, ABDM_ENV_VARS.clientSecret]);
  });

  it("is configured only when every prerequisite is present", () => {
    expect(getAbdmConfig(FULL).configured).toBe(true);
  });
});

describe("checkEnvironmentSafety", () => {
  it("flags a production deployment pointed at the sandbox", () => {
    const r = checkEnvironmentSafety(getAbdmConfig(FULL), "production");
    expect(r.safe).toBe(false);
    expect(r.warning).toMatch(/SANDBOX/);
  });

  it("flags a non-production deployment pointed at production", () => {
    const cfg = getAbdmConfig({ ...FULL, [ABDM_ENV_VARS.environment]: "PRODUCTION" });
    const r = checkEnvironmentSafety(cfg, "development");
    expect(r.safe).toBe(false);
    expect(r.warning).toMatch(/PRODUCTION/);
  });

  it("treats DISABLED as always safe", () => {
    expect(checkEnvironmentSafety(getAbdmConfig({}), "production").safe).toBe(true);
  });

  it("accepts a correctly matched environment", () => {
    expect(checkEnvironmentSafety(getAbdmConfig(FULL), "development").safe).toBe(true);
  });
});

describe("describeAbdmConfig", () => {
  it("never exposes the client id or secret", () => {
    const described = describeAbdmConfig(getAbdmConfig(FULL));
    const serialized = JSON.stringify(described);
    expect(serialized).not.toContain("client-1");
    expect(serialized).not.toContain("shhh");
    expect(described.credentialsConfigured).toBe(true);
  });
});

describe("adapters never fabricate connectivity", () => {
  it("reports NOT_CONFIGURED rather than a fake success when disabled", async () => {
    const adapter = new AbdmAdapter();
    const result = await adapter.send({ facilityId: "f1", idempotencyKey: "k1", body: {} });
    expect(result.outcome).toBe("NOT_CONFIGURED");
    expect(result.outcome).not.toBe("OK");
    expect(result.retryable).toBe(false);
    expect(result.message).toMatch(/not configured/i);
  });

  it("never returns a verified result from an unconfigured registry", async () => {
    for (const system of ["HFR", "HPR", "ABDM"] as const) {
      const result = await new AbdmRegistryAdapter(system).verify({ system: "s", value: "v" });
      expect(result.outcome).toBe("NOT_CONFIGURED");
      expect(result.data?.verified).toBeUndefined();
    }
  });

  it("advertises NO operations while unconfigured, so no dashboard can imply connectivity", async () => {
    const caps = await new AbdmAdapter().capabilities();
    expect(caps.configured).toBe(false);
    expect(caps.operations).toEqual([]);
  });

  it("refuses an unknown destination system instead of pretending", async () => {
    const adapter = getExchangeAdapter("SOME_OTHER_NETWORK");
    const result = await adapter.send({ facilityId: "f1", idempotencyKey: "k", body: {} });
    expect(result.outcome).toBe("NOT_CONFIGURED");
  });

  it("getStatus and cancel are equally honest", async () => {
    const adapter = new AbdmAdapter();
    expect((await adapter.getStatus("x")).outcome).toBe("NOT_CONFIGURED");
    expect((await adapter.cancel("x")).outcome).toBe("NOT_CONFIGURED");
  });
});
