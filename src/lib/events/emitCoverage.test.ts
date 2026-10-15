import { describe, it, expect } from "vitest";
import path from "node:path";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { analyze, libFiles, unemittingWriters, writingRoutes } from "./emitCoverage";
import { EMIT_EXEMPTIONS, ROUTE_WRITE_ALLOWLIST } from "./emitExemptions";
import { getEventContract } from "./catalogue";

/**
 * Workflow spine §6 — a state-changing service function must emit a domain
 * event, in its own transaction, or be listed (with a category and reason)
 * in emitExemptions.ts. Route handlers must not write domain tables directly.
 */
const ROOT = path.resolve(__dirname, "..", "..", "..");
const CATEGORIES = new Set(["PLANNED", "BOOKKEEPING", "REFERENCE_DATA", "CONFIGURATION", "NOT_YET_CATALOGUED"]);

describe("every state change emits a domain event (or is a listed exemption)", () => {
  const writers = unemittingWriters(ROOT);
  const writerKeys = new Set(writers.map((w) => w.key));

  it("has no unlisted service function that writes without emitting", () => {
    const unlisted = writers.filter((w) => !EMIT_EXEMPTIONS[w.key])
      .map((w) => `${w.key} (line ${w.line}) writes ${w.writes.join(", ")} but emits no event — emit one in the same transaction, or add it to emitExemptions.ts with a category`);
    expect(unlisted).toEqual([]);
  });

  it("has no stale exemption (the function emits now, no longer writes, or is gone)", () => {
    const stale = Object.keys(EMIT_EXEMPTIONS).filter((k) => !writerKeys.has(k));
    expect(stale).toEqual([]);
  });

  it("gives every exemption a known category, a reason, and PLANNED entries a step", () => {
    const bad = Object.entries(EMIT_EXEMPTIONS).filter(([, e]) =>
      !CATEGORIES.has(e.category) || e.reason.trim().length < 10 || (e.category === "PLANNED" && typeof e.step !== "number"));
    expect(bad.map(([k]) => k)).toEqual([]);
  });

  it("never emits through the global client from a function that also writes", () => {
    const outside = analyze(libFiles(ROOT), ROOT).filter((f) => f.emitsOutsideTx).map((f) => `${f.key} (line ${f.line})`);
    expect(outside).toEqual([]);
  });

  it("only emits event types that are in the catalogue", () => {
    const unknown: string[] = [];
    for (const f of libFiles(ROOT)) {
      for (const m of readFileSync(f, "utf8").matchAll(/emitDomainEvent\(\s*\w+\s*,\s*\{\s*type:\s*"(\w+)"/g)) {
        if (!getEventContract(m[1], 1)) unknown.push(`${path.relative(ROOT, f)}: ${m[1]}`);
      }
    }
    expect(unknown).toEqual([]);
  });
});

describe("the rule catches violations (fixtures)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "emit-cov-"));
  const file = path.join(dir, "fixture.ts");
  writeFileSync(file, `
    export async function silentWrite(tx: any) { await tx.patient.update({ where: { id: "x" }, data: {} }); }
    export async function emitsInTx(prisma: any) {
      await prisma.$transaction(async (tx: any) => { await tx.patient.create({ data: {} }); await emitDomainEvent(tx, { type: "PatientRegistered" }); });
    }
    export async function emitsOutside(prisma: any) {
      await prisma.$transaction(async (tx: any) => { await tx.patient.create({ data: {} }); });
      await emitDomainEvent(prisma, { type: "PatientRegistered" });
    }
    function helperThatEmits(tx: any) { return emitDomainEvent(tx, { type: "PatientRegistered" }); }
    export async function viaHelper(tx: any) { await tx.patient.delete({ where: { id: "x" } }); await helperThatEmits(tx); }
    export async function rawWrite(tx: any) { await tx.$executeRaw\`UPDATE "Patient" SET x = 1\`; }
    export async function readOnly(tx: any) { return tx.patient.findMany(); }
  `);
  const facts = analyze([file], dir);
  const byName = (n: string) => facts.find((f) => f.name === n)!;
  const emits = new Map(facts.map((f) => [f.name, f.emits || f.callees.some((c) => facts.some((g) => g.name === c && g.emits))]));

  it("flags a write with no event", () => {
    expect(byName("silentWrite").writes).toEqual(["patient.update"]);
    expect(emits.get("silentWrite")).toBe(false);
  });
  it("accepts an emit in the same transaction, or through a helper one level deep", () => {
    expect(emits.get("emitsInTx")).toBe(true);
    expect(byName("emitsInTx").emitsOutsideTx).toBe(false);
    expect(emits.get("viaHelper")).toBe(true);
  });
  it("flags an emit through the global client from a function that writes", () => {
    expect(byName("emitsOutside").emitsOutsideTx).toBe(true);
  });
  it("sees raw SQL writes and ignores reads", () => {
    expect(byName("rawWrite").writes).toEqual(["raw UPDATE Patient"]);
    expect(byName("readOnly").writes).toEqual([]);
  });
});

describe("route handlers write through services", () => {
  const routes = writingRoutes(ROOT);
  const keys = new Set(routes.map((r) => r.key));

  it("has no route handler writing domain tables that isn't on the shrinking allowlist", () => {
    const unlisted = routes.filter((r) => !ROUTE_WRITE_ALLOWLIST.includes(r.key))
      .map((r) => `${r.key} writes ${r.writes.join(", ")} directly — move the write into a service function`);
    expect(unlisted).toEqual([]);
  });

  it("has no stale route allowlist entry", () => {
    expect(ROUTE_WRITE_ALLOWLIST.filter((k) => !keys.has(k))).toEqual([]);
  });
});
