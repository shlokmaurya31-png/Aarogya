import { describe, it, expect } from "vitest";
import {
  parseFhirPayload, validateResource, validateBundle, validateReference,
  readIdentifiers, stripUntrustedMeta, FhirValidationError,
  MAX_PAYLOAD_BYTES, MAX_BUNDLE_ENTRIES, MAX_JSON_DEPTH,
} from "./validate";

/**
 * Phase C1 — FHIR payloads are UNTRUSTED INPUT.
 *
 * Every test here represents a real attack: memory exhaustion, stack
 * exhaustion, prototype pollution, unsupported resource smuggling, malformed
 * references, and the most subtle one — a payload trying to assert its own
 * authorization through meta.security.
 */

describe("parseFhirPayload size and shape limits", () => {
  it("rejects an empty payload", () => {
    expect(() => parseFhirPayload("")).toThrow(FhirValidationError);
  });

  it("rejects malformed JSON without leaking the parser error", () => {
    expect(() => parseFhirPayload("{not json")).toThrow(/not valid JSON/);
  });

  it("rejects a payload over the size ceiling", () => {
    const huge = JSON.stringify({ resourceType: "Patient", pad: "x".repeat(MAX_PAYLOAD_BYTES + 100) });
    expect(() => parseFhirPayload(huge)).toThrow(/limit is/);
  });

  it("rejects a top-level array or scalar", () => {
    expect(() => parseFhirPayload("[]")).toThrow(/must be a FHIR resource object/);
    expect(() => parseFhirPayload('"hello"')).toThrow(/must be a FHIR resource object/);
  });

  it("rejects JSON nested past the depth limit (stack exhaustion)", () => {
    let deep: unknown = { resourceType: "Patient" };
    for (let i = 0; i < MAX_JSON_DEPTH + 5; i++) deep = { nested: deep };
    expect(() => parseFhirPayload(JSON.stringify(deep))).toThrow(/nests deeper than/);
  });

  it("rejects prototype-pollution keys anywhere in the payload", () => {
    const attack = '{"resourceType":"Patient","extension":{"__proto__":{"isAdmin":true}}}';
    expect(() => parseFhirPayload(attack)).toThrow(/forbidden key/);
    const ctor = '{"resourceType":"Patient","a":{"constructor":{"x":1}}}';
    expect(() => parseFhirPayload(ctor)).toThrow(/forbidden key/);
  });

  it("does not pollute Object.prototype even when an attack is rejected", () => {
    try { parseFhirPayload('{"resourceType":"Patient","__proto__":{"polluted":"yes"}}'); } catch { /* expected */ }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("accepts a well-formed resource", () => {
    expect(parseFhirPayload('{"resourceType":"Patient","id":"p1"}')).toMatchObject({ resourceType: "Patient" });
  });
});

describe("validateResource", () => {
  it("requires a resourceType", () => {
    expect(() => validateResource({ id: "x" })).toThrow(/missing resourceType/);
  });

  it("refuses an unsupported resource type", () => {
    // Binary could smuggle arbitrary content; it is not on the allow-list.
    expect(() => validateResource({ resourceType: "Binary" })).toThrow(/unsupported resourceType: Binary/);
    expect(() => validateResource({ resourceType: "Subscription" })).toThrow(/unsupported resourceType/);
  });

  it("rejects a non-string or oversized id", () => {
    expect(() => validateResource({ resourceType: "Patient", id: 42 })).toThrow(/id must be a string/);
    expect(() => validateResource({ resourceType: "Patient", id: "x".repeat(65) })).toThrow(/exceeds 64/);
  });

  it("accepts a supported resource", () => {
    expect(validateResource({ resourceType: "Observation", id: "o1" }).resourceType).toBe("Observation");
  });
});

describe("validateBundle", () => {
  it("rejects a non-Bundle", () => {
    expect(() => validateBundle({ resourceType: "Patient" })).toThrow(/expected a Bundle/);
  });

  it("rejects an unsupported bundle type", () => {
    expect(() => validateBundle({ resourceType: "Bundle", type: "history" })).toThrow(/unsupported Bundle type/);
  });

  it("rejects a bundle with too many entries", () => {
    const entry = Array.from({ length: MAX_BUNDLE_ENTRIES + 1 }, () => ({ resource: { resourceType: "Patient" } }));
    expect(() => validateBundle({ resourceType: "Bundle", type: "collection", entry })).toThrow(/limit is/);
  });

  it("rejects a bundle whose entry list is not an array", () => {
    expect(() => validateBundle({ resourceType: "Bundle", type: "collection", entry: {} })).toThrow(/must be an array/);
  });

  it("propagates an unsupported type from a nested entry", () => {
    const bundle = { resourceType: "Bundle", type: "collection", entry: [{ resource: { resourceType: "Binary" } }] };
    expect(() => validateBundle(bundle)).toThrow(/unsupported resourceType: Binary/);
  });

  it("accepts a valid collection and skips request-only entries", () => {
    const bundle = {
      resourceType: "Bundle", type: "collection",
      entry: [{ resource: { resourceType: "Patient", id: "p1" } }, { request: { method: "GET", url: "Patient/1" } }],
    };
    expect(validateBundle(bundle).entries).toHaveLength(1);
  });
});

describe("validateReference", () => {
  it("accepts a well-formed relative reference", () => {
    expect(validateReference({ reference: "Patient/abc-123" }, "subject")).toEqual({ type: "Patient", id: "abc-123" });
  });

  it("rejects an absolute URL, which could point at an attacker host", () => {
    expect(() => validateReference({ reference: "https://evil.example/Patient/1" }, "subject")).toThrow(/not a valid relative reference/);
  });

  it("rejects path traversal and injection attempts", () => {
    expect(() => validateReference({ reference: "Patient/../../etc/passwd" }, "subject")).toThrow(/not a valid relative reference/);
    expect(() => validateReference({ reference: "Patient/1;DROP TABLE" }, "subject")).toThrow(/not a valid relative reference/);
  });

  it("rejects a missing or oversized reference", () => {
    expect(() => validateReference({}, "subject")).toThrow(/no reference string/);
    expect(() => validateReference({ reference: "Patient/" + "x".repeat(300) }, "subject")).toThrow(/too long/);
  });
});

describe("readIdentifiers", () => {
  it("extracts only well-formed system/value pairs", () => {
    const ids = readIdentifiers({
      identifier: [
        { system: "https://healthid.abdm.gov.in", value: "11-1111" },
        { system: 42, value: "bad" },
        { value: "no-system" },
        { system: "s", value: "x".repeat(200) },
      ],
    });
    expect(ids).toEqual([{ system: "https://healthid.abdm.gov.in", value: "11-1111" }]);
  });

  it("returns empty for a missing or non-array identifier field", () => {
    expect(readIdentifiers({})).toEqual([]);
    expect(readIdentifiers({ identifier: "nope" })).toEqual([]);
  });

  it("caps how many identifiers it will read", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ system: "s", value: `v${i}` }));
    expect(readIdentifiers({ identifier: many }).length).toBeLessThanOrEqual(20);
  });
});

describe("stripUntrustedMeta", () => {
  it("drops meta entirely so a payload cannot assert its own authorization", () => {
    const hostile = {
      resourceType: "Patient",
      meta: { security: [{ code: "ADMIN" }], tag: [{ code: "trusted" }], profile: ["urn:evil"] },
      name: [{ text: "Asha" }],
    };
    const safe = stripUntrustedMeta(hostile);
    expect(safe.meta).toBeUndefined();
    expect(safe.name).toBeDefined();
  });

  it("drops forbidden keys while preserving clinical content", () => {
    const safe = stripUntrustedMeta({ resourceType: "Patient", ["__proto__"]: { a: 1 }, gender: "female" });
    expect(safe.gender).toBe("female");
    expect(Object.keys(safe)).not.toContain("__proto__");
  });
});
