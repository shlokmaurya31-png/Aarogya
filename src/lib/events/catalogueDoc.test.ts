import { describe, it, expect } from "vitest";
import path from "node:path";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { EVENT_CONTRACTS, ALL_EVENT_TYPES } from "./catalogue";
import { getConsumers } from "./consumers";
import { registerAllConsumers, EXPECTED_CONSUMERS } from "@/lib/runner/consumers";
import { analyze, libFiles } from "./emitCoverage";
import { EMITTING_HELPERS } from "./emitExemptions";
import { describeSchema, emitSites, renderEventCatalogue } from "./catalogueDoc";

/** docs/EVENT_CATALOGUE.md is generated from the code; it must not drift from it. */
const ROOT = path.resolve(__dirname, "..", "..", "..");

describe("docs/EVENT_CATALOGUE.md", () => {
  registerAllConsumers();
  const sites = emitSites(analyze(libFiles(ROOT), ROOT), EMITTING_HELPERS);
  const rendered = renderEventCatalogue(EVENT_CONTRACTS, getConsumers(), sites);

  it("matches a fresh render of the catalogue, emit sites and consumers (run `npm run docs:events`)", () => {
    expect(readFileSync(path.join(ROOT, "docs", "EVENT_CATALOGUE.md"), "utf8")).toBe(rendered);
  });

  it("documents every event type and every registered consumer", () => {
    for (const t of ALL_EVENT_TYPES) expect(rendered).toContain(`### ${t}\n`);
    expect(getConsumers().map((c) => c.name).sort()).toEqual([...EXPECTED_CONSUMERS].sort());
    for (const c of getConsumers()) if (c.handles !== "*") for (const t of c.handles) expect(ALL_EVENT_TYPES).toContain(t);
  });

  it("finds an emit site for every current event type, and none for a retired one", () => {
    const retired = new Set(EVENT_CONTRACTS.filter((c) => c.retired).map((c) => c.type));
    expect(ALL_EVENT_TYPES.filter((t) => !retired.has(t) && !sites.get(t)?.length)).toEqual([]);
    expect([...retired].filter((t) => sites.get(t)?.length)).toEqual([]);
  });

  it("describes field types readably", () => {
    expect(describeSchema(z.enum(["A", "B"]).optional())).toBe("A \\| B");
    expect(describeSchema(z.array(z.string()))).toBe("string[]");
    expect(describeSchema(z.object({ a: z.number().nullable() }))).toBe("{ a∅: number }");
  });
});
