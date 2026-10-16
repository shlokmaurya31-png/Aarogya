import { describe, it, expect } from "vitest";
import path from "node:path";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { analyze, libFiles, resolveEmitTypes, unemittingWriters, writingRoutes } from "./emitCoverage";
import { EMIT_EXEMPTIONS, EMIT_EXEMPTION_CATEGORIES, EMITTING_HELPERS, OWED_EVENTS, REQUIRED_PAYLOAD_FIELDS, ROUTE_WRITE_ALLOWLIST, SENSITIVE_EVENTS } from "./emitExemptions";
import { EVENT_CONTRACTS, getEventContract } from "./catalogue";
import type { z } from "zod";

/**
 * Workflow spine §6 — a state-changing service function must emit a domain
 * event, in its own transaction, or be listed (with a category and reason)
 * in emitExemptions.ts. Route handlers must not write domain tables directly.
 */
const ROOT = path.resolve(__dirname, "..", "..", "..");
const CATEGORIES = new Set<string>(EMIT_EXEMPTION_CATEGORIES);
const SUB_STEPS = new Set(["5b", "9a", "9b", "9c"]);
const EVENT_NAME = /^[A-Z][A-Za-z0-9]+$/;
/** Event types that are catalogued, or owed by a PLANNED / OWED_EVENTS entry. */
const KNOWN_OR_OWED = new Set<string>([
  ...EVENT_CONTRACTS.map((c) => c.type),
  ...Object.values(EMIT_EXEMPTIONS).flatMap((e) => (e.category === "PLANNED" ? e.events ?? [] : [])),
  ...Object.values(OWED_EVENTS).map((o) => o.event),
]);

describe("every state change emits a domain event (or is a listed exemption)", () => {
  const facts = analyze(libFiles(ROOT), ROOT);
  const factByKey = new Map(facts.map((f) => [f.key, f]));
  const types = resolveEmitTypes(facts, EMITTING_HELPERS);
  const writers = unemittingWriters(ROOT, EMITTING_HELPERS);
  const writerKeys = new Set(writers.map((w) => w.key));

  it("has no unlisted service function that writes without emitting", () => {
    const unlisted = writers.filter((w) => !EMIT_EXEMPTIONS[w.key])
      .map((w) => `${w.key} (line ${w.line}) writes ${w.writes.join(", ")} but emits no event — emit one in the same transaction, or add it to emitExemptions.ts with a category`);
    expect(unlisted).toEqual([]);
  });

  it("has no stale exemption (the function emits now, no longer writes, or is gone)", () => {
    const stale = Object.entries(EMIT_EXEMPTIONS).flatMap(([k, e]) => {
      if (e.category !== "PLANNED") return writerKeys.has(k) ? [] : [k];
      // A planned producer is judged by ITS event: emitting another one doesn't clear it.
      const fn = factByKey.get(k);
      if (!fn || fn.writes.length === 0) return [`${k} is gone or no longer writes`];
      return (e.events ?? []).every((t) => types.get(k)?.has(t)) ? [`${k} emits ${e.events!.join(", ")} now — remove the entry`] : [];
    });
    expect(stale).toEqual([]);
  });

  it("registers only emitting helpers that really emit what they declare", () => {
    const own = resolveEmitTypes(facts); // without the registry: direct + one level
    const problems = Object.entries(EMITTING_HELPERS).flatMap(([k, declared]) => {
      if (!factByKey.has(k)) return [`${k} is gone`];
      return declared.flatMap((t) => [
        ...(own.get(k)?.has(t) ? [] : [`${k} does not emit ${t}`]),
        ...(getEventContract(t, 1) ? [] : [`${k}: ${t} is not in the catalogue`]),
      ]);
    });
    expect(problems).toEqual([]);
  });

  it("gives every exemption a known category, a reason, and PLANNED entries a step", () => {
    const validStep = (s: unknown) => typeof s === "number" || (typeof s === "string" && SUB_STEPS.has(s));
    const bad = Object.entries(EMIT_EXEMPTIONS).filter(([, e]) =>
      !CATEGORIES.has(e.category) || e.reason.trim().length < 10
      || (e.category === "PLANNED" && (!validStep(e.step) || !e.events?.length || !e.events.every((t) => EVENT_NAME.test(t))))
      || (e.category !== "PLANNED" && (e.step !== undefined || e.events !== undefined)));
    expect(bad.map(([k]) => k)).toEqual([]);
  });

  it("has nothing left uncatalogued: every writer is an event or a named exemption", () => {
    const left = Object.entries(EMIT_EXEMPTIONS).filter(([, e]) => (e.category as string) === "NOT_YET_CATALOGUED").map(([k]) => k);
    expect(CATEGORIES.has("NOT_YET_CATALOGUED")).toBe(false);
    expect(left).toEqual([]);
  });

  it("names, for every process step, a boundary event that is catalogued or owed", () => {
    const bad = Object.entries(EMIT_EXEMPTIONS).flatMap(([k, e]) => {
      if (e.category !== "PROCESS_STEP") return e.boundary ? [`${k}: only a PROCESS_STEP has a boundary`] : [];
      if (!e.boundary?.length) return [`${k}: no boundary event`];
      return e.boundary.filter((t) => !EVENT_NAME.test(t) || !KNOWN_OR_OWED.has(t)).map((t) => `${k}: boundary ${t} is neither catalogued nor owed`);
    });
    expect(bad).toEqual([]);
  });

  it("keeps sensitive facts SENSITIVE, and every listed one catalogued or owed", () => {
    const bad = SENSITIVE_EVENTS.flatMap((t) => {
      const c = EVENT_CONTRACTS.filter((x) => x.type === t);
      if (!c.length) return KNOWN_OR_OWED.has(t) ? [] : [`${t} is neither catalogued nor owed`];
      return c.filter((x) => x.sensitivity !== "SENSITIVE").map((x) => `${t}@${x.version} is ${x.sensitivity}, not SENSITIVE`);
    });
    expect(bad).toEqual([]);
  });

  it("gives the merged events the closed type codes their approval requires", () => {
    const bad = Object.entries(REQUIRED_PAYLOAD_FIELDS).flatMap(([t, fields]) =>
      EVENT_CONTRACTS.filter((c) => c.type === t).flatMap((c) => {
        const shape = (c.payload as unknown as z.ZodObject<z.ZodRawShape>).shape ?? {};
        return fields.filter((f) => !(f in shape)).map((f) => `${t}@${c.version} lacks ${f}`);
      }));
    expect(bad).toEqual([]);
  });

  it("tracks events still owed by functions that already emit something else", () => {
    const problems = Object.entries(OWED_EVENTS).flatMap(([key, { event }]) => {
      if (!factByKey.has(key)) return [`${key} is gone`];
      return types.get(key)?.has(event) ? [`${key} emits ${event} now — remove it from OWED_EVENTS`] : [];
    });
    expect(problems).toEqual([]);
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
    export async function registeredHelper(tx: any) { await emitDomainEvent(tx, { type: "StockMoved" }); }
    function middle(tx: any) { return registeredHelper(tx); }
    export async function deepViaRegistered(tx: any) { await tx.item.update({}); await middle(tx); }
    export function unregisteredEmitter(tx: any) { return emitDomainEvent(tx, { type: "PatientRegistered" }); }
    export function middle2(tx: any) { return unregisteredEmitter(tx); }
    export async function deepViaUnregistered(tx: any) { await tx.item.update({}); await middle2(tx); }
    async function privateWrite(tx: any) { await tx.item.update({}); }
    function privateMiddle(tx: any) { return privateWrite(tx); }
    export async function writesViaPrivate(tx: any) { await privateMiddle(tx); }
    function privateEmit(tx: any) { return emitFacilityEvent(tx, { type: "StockMoved" }); }
    function privateEmitMiddle(tx: any) { return privateEmit(tx); }
    export async function emitsViaPrivate(tx: any) { await privateWrite(tx); await privateEmitMiddle(tx); }
    export async function emitsOther(tx: any) { await tx.item.update({}); await emitFacilityEvent(tx, { type: "TaskCreated" }); }
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
  it("follows private same-file helpers at any depth, for writes and for emits", () => {
    expect(byName("writesViaPrivate").writes).toEqual(["item.update (via privateWrite)"]);
    const t = resolveEmitTypes(facts);
    expect([...t.get(byName("emitsViaPrivate").key)!]).toEqual(["StockMoved"]);
    expect(byName("emitsViaPrivate").emits).toBe(false); // emitFacilityEvent is not emitDomainEvent; its type is what counts
  });
  it("follows a registered emitting helper at any depth, an exported unregistered one only one level", () => {
    const helpers = { [byName("registeredHelper").key]: ["StockMoved"] };
    const t = resolveEmitTypes(facts, helpers);
    expect([...t.get(byName("deepViaRegistered").key)!]).toEqual(["StockMoved"]);
    expect([...t.get(byName("deepViaUnregistered").key)!]).toEqual([]);
  });
  it("records the event type a function emits, so a different type does not satisfy a planned one", () => {
    const t = resolveEmitTypes(facts);
    expect([...t.get(byName("emitsOther").key)!]).toEqual(["TaskCreated"]);
    expect(t.get(byName("emitsOther").key)!.has("StockMoved")).toBe(false);
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
