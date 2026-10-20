import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertGateDatabase, gateDatabaseProblem } from "./gateGuard";

const VERIFY = "postgresql://aarogya:aarogya@localhost:5432/aarogya_verify";
const DEV = "postgresql://aarogya:aarogya@localhost:5432/aarogya";

describe("gate database guard", () => {
  it("accepts both URLs on aarogya_verify at a local host", () => {
    expect(gateDatabaseProblem({ DATABASE_URL: VERIFY, DIRECT_URL: VERIFY })).toBeNull();
    const loop = "postgresql://aarogya:aarogya@127.0.0.1:5432/aarogya_verify?schema=public";
    expect(() => assertGateDatabase({ DATABASE_URL: loop, DIRECT_URL: VERIFY })).not.toThrow();
  });

  it("refuses when DIRECT_URL still points at the dev database (the migrate trap)", () => {
    expect(gateDatabaseProblem({ DATABASE_URL: VERIFY, DIRECT_URL: DEV })).toMatch(/DIRECT_URL names the database "aarogya"/);
  });

  it("refuses when DATABASE_URL points at the dev database", () => {
    expect(() => assertGateDatabase({ DATABASE_URL: DEV, DIRECT_URL: VERIFY })).toThrow(/Refusing to start: DATABASE_URL/);
  });

  it("refuses a missing URL", () => {
    expect(gateDatabaseProblem({ DATABASE_URL: VERIFY })).toMatch(/DIRECT_URL is not set/);
    expect(gateDatabaseProblem({ DIRECT_URL: VERIFY })).toMatch(/DATABASE_URL is not set/);
  });

  it("refuses a remote host even with the right database name (staging included)", () => {
    const remote = "postgresql://u:p@db.abcdefgh.supabase.co:5432/aarogya_verify";
    expect(gateDatabaseProblem({ DATABASE_URL: remote, DIRECT_URL: remote })).toMatch(/not localhost/);
    // No override opens it.
    expect(gateDatabaseProblem({ DATABASE_URL: remote, DIRECT_URL: remote, ALLOW_REMOTE_VERIFY: "1" })).toMatch(/not localhost/);
  });

  it("refuses look-alike names and non-Postgres URLs", () => {
    for (const db of ["aarogya_verify2", "aarogya_e2e", "Aarogya_Verify", ""]) {
      const url = `postgresql://aarogya:aarogya@localhost:5432/${db}`;
      expect(gateDatabaseProblem({ DATABASE_URL: url, DIRECT_URL: url })).not.toBeNull();
    }
    expect(gateDatabaseProblem({ DATABASE_URL: "mysql://localhost/aarogya_verify", DIRECT_URL: VERIFY })).toMatch(/not a PostgreSQL URL/);
    expect(gateDatabaseProblem({ DATABASE_URL: "not a url", DIRECT_URL: VERIFY })).toMatch(/not a valid URL/);
  });
});

describe("every gate and verify script loads the guard first", () => {
  const scriptsDir = path.resolve(__dirname, "..");
  const gates = readdirSync(scriptsDir).filter((f) => /^verify-.+\.ts$/.test(f) && f !== "verify-all.ts");

  it("finds the gates", () => {
    expect(gates.length).toBeGreaterThan(90);
  });

  it.each(gates)("%s imports ./lib/gateBootstrap before anything else", (file) => {
    const source = readFileSync(path.join(scriptsDir, file), "utf8");
    const firstImport = source.split("\n").find((l) => /^\s*(import|export)\b|^\s*(const|let|var)\s.*require\(/.test(l));
    expect(firstImport?.trim()).toBe('import "./lib/gateBootstrap";');
  });

  it("verify-all asserts the guard on the environment it hands every child", () => {
    const source = readFileSync(path.join(scriptsDir, "verify-all.ts"), "utf8");
    expect(source).toMatch(/assertGateDatabase\(childEnv\)/);
  });
});
