/**
 * docs/DATA_DICTIONARY.md §1.3: rows carry their parent's facilityId so tenant
 * filters stay single-table. This checks the copies agree — for every model
 * with a facilityId and a foreign key to another model with a facilityId
 * (derived from the Prisma schema, so new models are covered automatically),
 * no row's facilityId differs from its parent's.
 *
 * Runs late in verify:all so it covers the seed and every earlier gate's rows.
 * Relations that may legitimately cross facilities are listed in CROSS_FACILITY
 * with the reason.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-facility-consistency.ts
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/db";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

/** "Model.relation" pairs whose parent may sit in another facility, by design. */
const CROSS_FACILITY: Record<string, string> = {};

async function main() {
  const models = Prisma.dmmf.datamodel.models;
  const hasFacility = new Set(models.filter((m) => m.fields.some((f) => f.name === "facilityId" && f.kind === "scalar")).map((m) => m.name));
  const dbName = (m: (typeof models)[number]) => m.dbName ?? m.name;
  const byName = new Map(models.map((m) => [m.name, m]));

  const pairs: { child: string; relation: string; parent: string; fk: string; ref: string }[] = [];
  for (const m of models) {
    if (!hasFacility.has(m.name) || m.name === "Facility") continue;
    for (const f of m.fields) {
      if (f.kind !== "object" || !f.relationFromFields?.length || f.relationFromFields.length !== 1) continue;
      if (!hasFacility.has(f.type) || f.type === "Facility") continue;
      if (f.relationFromFields[0] === "facilityId") continue;
      pairs.push({ child: m.name, relation: f.name, parent: f.type, fk: f.relationFromFields[0], ref: f.relationToFields?.[0] ?? "id" });
    }
  }
  report(`Found the facility-scoped parent/child pairs in the schema (${pairs.length})`, pairs.length > 50);

  const mismatched: string[] = [];
  let checkedRows = 0;
  for (const p of pairs) {
    if (CROSS_FACILITY[`${p.child}.${p.relation}`]) continue;
    const c = dbName(byName.get(p.child)!);
    const t = dbName(byName.get(p.parent)!);
    const rows = await prisma.$queryRawUnsafe<{ total: bigint; bad: bigint }[]>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE c."facilityId" IS NOT NULL AND t."facilityId" IS NOT NULL AND c."facilityId" <> t."facilityId") AS bad
         FROM "${c}" c JOIN "${t}" t ON t."${p.ref}" = c."${p.fk}"`
    );
    checkedRows += Number(rows[0].total);
    if (Number(rows[0].bad) > 0) mismatched.push(`${p.child}.${p.relation} → ${p.parent}: ${rows[0].bad} of ${rows[0].total}`);
  }
  report(`Every child's facilityId equals its parent's (${checkedRows} linked rows checked)`, mismatched.length === 0, mismatched.slice(0, 10).join("; "));

  // The check must be able to fail: plant one mismatch inside a rolled-back transaction.
  const planted = await prisma.$transaction(async (tx) => {
    const enc = await tx.encounter.findFirst({ where: { facilityId: "fac-amc-pune" }, orderBy: { id: "asc" } });
    if (!enc) return "no encounter to test with";
    await tx.encounterLocation.create({ data: { encounterId: enc.id, facilityId: "fac-amc-noida", areaLabel: "facility-consistency probe" } });
    const r = await tx.$queryRawUnsafe<{ bad: bigint }[]>(
      `SELECT count(*) AS bad FROM "EncounterLocation" c JOIN "Encounter" t ON t."id" = c."encounterId" WHERE c."facilityId" <> t."facilityId"`
    );
    throw Object.assign(new Error("rollback"), { bad: Number(r[0].bad) });
  }).catch((e: { bad?: number; message: string }) => (e.bad !== undefined ? e.bad : e.message));
  report("A planted mismatch is detected (then rolled back)", typeof planted === "number" && planted >= 1, String(planted));

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
