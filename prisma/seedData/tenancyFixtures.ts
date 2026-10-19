/**
 * Tenancy-sweep fixtures: guarantees that a row of any model exists inside a
 * given tenant, so scripts/verify-postgres-tenancy-sweep.ts can probe every
 * record-ID route with an ID the *other* tenant owns.
 *
 * Deliberately NOT part of the demo seed (prisma/seed.ts): these are minimal,
 * synthetic probe rows, and staging:seed runs the demo seed. The gate calls
 * this after the demo seed, on its own throwaway database.
 *
 * The builder is generic, driven by Prisma's schema metadata (DMMF):
 *   - an existing row of the model inside the tenant is reused;
 *   - otherwise a row is created with every required scalar filled, every
 *     required parent ensured inside the SAME tenant (recursively), and the
 *     tenant's facilityId / organizationId set wherever the model has them.
 * Ownership follows the gate's rule: a facilityId column, else an
 * organizationId column, else one required parent that is tenant-owned.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";

export interface Tenant {
  facilityId: string;
  organizationId: string;
}

type Field = Prisma.DMMF.Field;
type Model = Prisma.DMMF.Model;

const MODELS = new Map<string, Model>(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));
const ENUMS = new Map<string, string[]>(Prisma.dmmf.datamodel.enums.map((e) => [e.name, e.values.map((v) => v.name)]));
const MAX_DEPTH = 8;
/**
 * Optional relations a CHECK constraint makes mandatory in practice (the DMMF
 * can't see CHECK constraints): ClinicalDocument needs exactly one source (an
 * uploader here).
 */
/**
 * Fixture rows of the background machinery are created already finished, so
 * the runner never picks them up: a RUNNABLE instance or a PENDING event left
 * by a tenancy sweep would otherwise sit in (or churn through) the queues.
 */
const INERT: Record<string, Record<string, unknown>> = {
  // A cleared hold: Discharge has no tenant column, so every tenant's fixture
  // shares a discharge, and only active holds are unique per reason.
  DischargeHold: { clearedAt: new Date(), clearedByUserId: "tsw-fixture" },
  WorkflowInstance: { status: "COMPLETED" },
  WorkflowStep: { status: "COMPLETED" },
  WorkflowTimer: { status: "COMPLETED" },
  DomainEventOutbox: { status: "PROCESSED" },
  DomainEventDelivery: { status: "PROCESSED" },
  // Week 4c: a share and a request name at least one category (CHECK); ended, so nothing reads through them.
  RecordShare: { categories: ["LABS"], status: "ENDED" },
  AccessRequest: { categories: ["LABS"], status: "CANCELLED" },
};

const FILL_OPTIONAL: Record<string, string[]> = {
  ClinicalDocument: ["uploadedBy"],
};

/**
 * Text columns constrained to a value list by a CHECK (docs/POSTGRES_CUTOVER_REPORT.md
 * §8.2(b)), read from Postgres because the DMMF can't see CHECKs:
 * "Model.field" -> allowed values. A fixture uses the first.
 */
let checkedValues: Map<string, string[]> | null = null;
async function loadCheckedValues(db: PrismaClient): Promise<Map<string, string[]>> {
  if (checkedValues) return checkedValues;
  const rows = await db.$queryRaw<{ tbl: string; def: string }[]>`
    SELECT c.conrelid::regclass::text AS tbl, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.contype = 'c' AND n.nspname = 'public'`;
  checkedValues = new Map();
  for (const { tbl, def } of rows) {
    const m = /^CHECK \(\("?(\w+)"?\)?(?:::text)? = ANY \(\(?ARRAY\[(.*?)\]/.exec(def);
    if (!m) continue;
    const values = [...m[2].matchAll(/'([^']*)'/g)].map((v) => v[1]);
    checkedValues.set(`${tbl.replace(/"/g, "")}.${m[1]}`, values);
  }
  return checkedValues;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const delegate = (db: PrismaClient, model: string): any => (db as any)[model[0].toLowerCase() + model.slice(1)];
const has = (m: Model, field: string) => m.fields.some((f) => f.name === field && f.kind === "scalar");
const requiredParents = (m: Model) =>
  m.fields.filter((f) => f.kind === "object" && !f.isList && f.isRequired && (f.relationFromFields?.length ?? 0) === 1);

/** The `where` that selects the model's rows owned by `tenant`, or null if the model has no tenant. */
export function ownershipWhere(model: string, tenant: Tenant): Record<string, unknown> | null {
  const m = MODELS.get(model);
  if (!m) throw new Error(`Unknown model ${model}`);
  if (model === "Facility") return { id: tenant.facilityId };
  if (model === "Organization") return { id: tenant.organizationId };
  if (has(m, "facilityId")) return { facilityId: tenant.facilityId };
  if (has(m, "organizationId")) return { organizationId: tenant.organizationId };
  for (const parent of requiredParents(m)) {
    const pm = MODELS.get(parent.type)!;
    if (has(pm, "facilityId")) return { [parent.name]: { facilityId: tenant.facilityId } };
    if (parent.type === "Facility") return { [parent.relationFromFields![0]]: tenant.facilityId };
  }
  return null;
}

function scalarValue(model: string, f: Field): unknown {
  const tag = `${model}-${f.name}-${randomBytes(4).toString("hex")}`;
  switch (f.type) {
    case "String": return `tsw-${tag}`;
    case "Int": return 1;
    case "BigInt": return BigInt(1);
    case "Float": return 1;
    case "Decimal": return new Prisma.Decimal(1);
    case "Boolean": return false;
    case "DateTime": return new Date();
    case "Json": return {};
    case "Bytes": return Buffer.from(tag);
    default: throw new Error(`No fixture value for ${model}.${f.name}: ${f.type}`);
  }
}

/**
 * Ensures at least one `model` row owned by `tenant` exists and returns its id.
 * Models with no tenant (e.g. User) reuse any row, or create one.
 */
export async function ensureFixture(db: PrismaClient, model: string, tenant: Tenant, depth = 0): Promise<string> {
  if (model === "Facility") return tenant.facilityId;
  if (model === "Organization") return tenant.organizationId;
  if (depth > MAX_DEPTH) throw new Error(`Fixture recursion too deep at ${model}`);
  const m = MODELS.get(model);
  if (!m) throw new Error(`Unknown model ${model}`);
  const where = ownershipWhere(model, tenant) ?? {};
  const existing = await delegate(db, model).findFirst({ where, select: { id: true }, orderBy: { id: "asc" } });
  if (existing) return existing.id;

  const fkFields = new Set(m.fields.flatMap((f) => (f.kind === "object" ? f.relationFromFields ?? [] : [])));
  const data: Record<string, unknown> = {};
  for (const f of m.fields) {
    if (f.kind === "object") {
      if (f.isList || (f.relationFromFields?.length ?? 0) !== 1) continue;
      const fk = f.relationFromFields![0];
      // Tenant columns always point at the tenant; other required parents are
      // ensured inside the same tenant; optional parents stay empty.
      if (f.type === "Facility") data[fk] = tenant.facilityId;
      else if (f.type === "Organization") data[fk] = tenant.organizationId;
      else if (f.isRequired || FILL_OPTIONAL[model]?.includes(f.name)) data[fk] = await ensureFixture(db, f.type, tenant, depth + 1);
      continue;
    }
    if (fkFields.has(f.name) || f.isGenerated || f.isUpdatedAt || f.isReadOnly) continue;
    // Tenant columns without a @relation (plain String facilityId /
    // organizationId) still belong to the tenant.
    if (f.name === "facilityId") { data[f.name] = tenant.facilityId; continue; }
    if (f.name === "organizationId") { data[f.name] = tenant.organizationId; continue; }
    if (!f.isRequired || f.hasDefaultValue) continue;
    if (f.isList) { data[f.name] = []; continue; }
    if (f.kind === "enum") { data[f.name] = ENUMS.get(f.type)![0]; continue; }
    const allowed = f.type === "String" ? (await loadCheckedValues(db)).get(`${model}.${f.name}`) : undefined;
    data[f.name] = allowed ? allowed[0] : scalarValue(model, f);
  }
  Object.assign(data, INERT[model] ?? {});
  try {
    const row = await delegate(db, model).create({ data, select: { id: true } });
    return row.id;
  } catch (err) {
    // A unique collision means a matching tenant row appeared meanwhile, or an
    // enum-valued unique key is already taken in this tenant: reuse it.
    if ((err as { code?: string }).code === "P2002") {
      const again = await delegate(db, model).findFirst({ where, select: { id: true }, orderBy: { id: "asc" } });
      if (again) return again.id;
    }
    throw new Error(`Could not create a ${model} fixture: ${(err as Error).message.split("\n").slice(-3).join(" ")}`);
  }
}

export const fixtureModels = () => [...MODELS.keys()];
