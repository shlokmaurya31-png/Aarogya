import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { PERSON_SCOPED_MODELS, FACILITY_MODELS_WITH_PERSON } from "./tenancy";

const models = Prisma.dmmf.datamodel.models;
const fields = (name: string) => models.find((m) => m.name === name)!.fields.map((f) => f.name);

describe("the PERSON tenancy segment matches the schema", () => {
  it("person-scoped models carry a person and no tenant", () => {
    for (const m of PERSON_SCOPED_MODELS) {
      const f = fields(m);
      expect(f, m).not.toContain("facilityId");
      expect(f, m).not.toContain("organizationId");
      if (m !== "Person") expect(f, m).toContain("personId");
    }
  });
  it("every model with a personId is classified, person-scoped or facility-owned", () => {
    const withPerson = models.filter((m) => m.fields.some((f) => f.name === "personId")).map((m) => m.name).sort();
    const classified = [...PERSON_SCOPED_MODELS, ...FACILITY_MODELS_WITH_PERSON].filter((m) => m !== "Person").sort();
    expect(withPerson).toEqual(classified);
  });
  it("facility-owned models with a person are tenanted", () => {
    for (const m of FACILITY_MODELS_WITH_PERSON) expect(fields(m), m).toContain("facilityId");
  });
});
