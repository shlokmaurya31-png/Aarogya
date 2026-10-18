import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PERSON_SCOPED_MODELS, FACILITY_MODELS_WITH_PERSON } from "./tenancy";

/**
 * A Person merge must move everything the merged-away Person owns. When a new
 * model gains a personId, this fails until mergePersonsTx re-points it (or it
 * is listed here with why not). Found when person documents (part 2c) were
 * missed by the merge (part 2b).
 */
const NOT_REPOINTED: Record<string, string> = {
  Person: "the merged Person itself (marked MERGED)",
  PersonAccount: "the merged-away login is ended, not moved",
  PersonMergeRequest: "the request that caused the merge",
  PersonMergeRecord: "the merge's own record",
  DomainEventOutbox: "events are history; they keep the Person they were about",
};

describe("a Person merge re-points every model that carries a personId", () => {
  const src = readFileSync(path.join(__dirname, "merge.ts"), "utf8");
  for (const model of [...PERSON_SCOPED_MODELS, ...FACILITY_MODELS_WITH_PERSON]) {
    if (NOT_REPOINTED[model]) continue;
    it(model, () => {
      const delegate = model[0].toLowerCase() + model.slice(1);
      expect(src).toContain(`tx.${delegate}.updateMany({ where: { personId: from }`);
    });
  }
});
