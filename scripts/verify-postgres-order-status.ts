/**
 * D9: the specific order's lifecycle is authoritative; Order.status is derived
 * from it and written only by syncOrderStatus (src/lib/hospital/orderEnvelope.ts).
 *
 *   1. Every specific status (all four kinds) maps to an Order status.
 *   2. Only orderEnvelope.ts writes the Order table, and every file that
 *      changes a specific order's status calls syncOrderStatus.
 *   3. Walk every transition of every specific-order lifecycle: after each one
 *      (specific update + sync in one transaction) Order.status equals the
 *      derived status. A failed transaction leaves both unchanged.
 *   4. Across the whole database (the seed and every earlier gate's orders),
 *      no envelope's status disagrees with its specific order.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-order-status.ts
 */
import "./lib/gateBootstrap";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { $Enums, type Prisma } from "@prisma/client";
import { prisma } from "../src/lib/db";
import { deriveOrderStatus, syncOrderStatus, createOrderEnvelope, REFERRAL_STATUSES, type SpecificOrderKind } from "../src/lib/hospital/orderEnvelope";
import { isMedicationOrderTransitionAllowed } from "../src/lib/hospital/medicationLifecycle";
import { staffAtFacilityWhere } from "../src/lib/auth/staffFacility";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

const STATUSES: Record<SpecificOrderKind, string[]> = {
  MEDICATION: Object.values($Enums.MedicationOrderStatus),
  LAB: Object.values($Enums.LabOrderStatus),
  IMAGING: Object.values($Enums.ImagingOrderStatus),
  REFERRAL: REFERRAL_STATUSES,
};

/** Each lifecycle's edges. Medication's come from its own transition table. */
function edges(kind: SpecificOrderKind): [string, string][] {
  const chain = (steps: string[], cancelFrom: string[]) => [
    ...steps.slice(1).map((to, i) => [steps[i], to] as [string, string]),
    ...cancelFrom.map((from) => [from, "CANCELLED"] as [string, string]),
  ];
  switch (kind) {
    case "MEDICATION": {
      const all = STATUSES.MEDICATION as $Enums.MedicationOrderStatus[];
      return all.flatMap((from) => all.filter((to) => isMedicationOrderTransitionAllowed(from, to)).map((to) => [from, to] as [string, string]));
    }
    case "LAB":
      return chain(["ORDERED", "COLLECTED", "IN_PROGRESS", "RESULTED"], ["ORDERED", "COLLECTED", "IN_PROGRESS"]);
    case "IMAGING":
      return chain(["ORDERED", "SCHEDULED", "ACQUIRED", "REPORTED"], ["ORDERED", "SCHEDULED", "ACQUIRED"]);
    case "REFERRAL": {
      // The referral PATCH route accepts any of these from any open state.
      const open = ["DRAFT", "PLACED", "ACKNOWLEDGED", "IN_PROGRESS"];
      const to = ["ACKNOWLEDGED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "REJECTED"];
      return [["DRAFT", "PLACED"], ...open.flatMap((f) => to.filter((t) => t !== f).map((t) => [f, t] as [string, string]))];
    }
  }
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
}

async function main() {
  // 1. Totality of the mapping.
  for (const kind of Object.keys(STATUSES) as SpecificOrderKind[]) {
    const unmapped = STATUSES[kind].filter((s) => { try { deriveOrderStatus(kind, s); return false; } catch { return true; } });
    report(`Every ${kind} status maps to an Order status`, unmapped.length === 0, unmapped.join(","));
  }

  // 2. One writer.
  const root = path.resolve(__dirname, "..", "src");
  const files = walk(root);
  const orderWriters = files.filter((f) => /\b(tx|prisma|db)\.order\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|(UPDATE|INSERT INTO)\s+"Order"/.test(readFileSync(f, "utf8")))
    .map((f) => path.relative(root, f));
  report("Only orderEnvelope.ts writes the Order table", orderWriters.length === 1 && orderWriters[0] === path.join("lib", "hospital", "orderEnvelope.ts"), orderWriters.join(", "));
  const statusWriters = files.filter((f) => {
    const src = readFileSync(f, "utf8");
    return /\.(medicationOrder|labOrder|imagingOrder|referral)\.(update|updateMany|upsert)\(\{[^;]*?status/.test(src) && !f.endsWith("orderEnvelope.ts");
  });
  const unsynced = statusWriters.filter((f) => !readFileSync(f, "utf8").includes("syncOrderStatus(")).map((f) => path.relative(root, f));
  report(`Every file that changes a specific order's status syncs the envelope (${statusWriters.length} files)`, unsynced.length === 0, unsynced.join(", "));

  // 3. Walk every transition.
  const facilityId = "fac-amc-pune";
  const encounter = await prisma.encounter.findFirstOrThrow({ where: { facilityId }, orderBy: [{ registeredAt: "asc" }, { id: "asc" }] });
  const staff = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { AND: [staffAtFacilityWhere(facilityId), { user: { role: "DOCTOR" } }] }, orderBy: { id: "asc" } });
  const base = { encounterId: encounter.id, patientId: encounter.patientId };

  async function makeSpecific(tx: Prisma.TransactionClient, kind: SpecificOrderKind, status: string) {
    const env = await createOrderEnvelope(tx, { facilityId, ...base, orderingStaffId: staff.id, orderType: kind });
    const s = status as never;
    switch (kind) {
      case "MEDICATION": return (await tx.medicationOrder.create({ data: { ...base, drugName: "D9 gate", dose: "1", route: "oral", frequency: "OD", orderedByStaffId: staff.id, orderId: env.id, status: s } })).id;
      case "LAB": return (await tx.labOrder.create({ data: { ...base, testName: "D9 gate", category: "Biochemistry", orderedByStaffId: staff.id, orderId: env.id, status: s } })).id;
      case "IMAGING": return (await tx.imagingOrder.create({ data: { ...base, modality: "XRAY", studyDescription: "D9 gate", orderedByStaffId: staff.id, orderId: env.id, status: s } })).id;
      case "REFERRAL": return (await tx.referral.create({ data: { ...base, fromStaffId: staff.id, reason: "D9 gate", orderId: env.id, status: s } })).id;
    }
  }
  async function setStatus(tx: Prisma.TransactionClient, kind: SpecificOrderKind, id: string, status: string) {
    const data = { status: status as never };
    switch (kind) {
      case "MEDICATION": await tx.medicationOrder.update({ where: { id }, data }); break;
      case "LAB": await tx.labOrder.update({ where: { id }, data }); break;
      case "IMAGING": await tx.imagingOrder.update({ where: { id }, data }); break;
      case "REFERRAL": await tx.referral.update({ where: { id }, data }); break;
    }
    await syncOrderStatus(tx, kind, id);
  }
  async function statuses(kind: SpecificOrderKind, id: string) {
    const q = { where: { id }, select: { status: true, order: { select: { status: true } } } } as const;
    const row = kind === "MEDICATION" ? await prisma.medicationOrder.findUniqueOrThrow(q)
      : kind === "LAB" ? await prisma.labOrder.findUniqueOrThrow(q)
      : kind === "IMAGING" ? await prisma.imagingOrder.findUniqueOrThrow(q)
      : await prisma.referral.findUniqueOrThrow(q);
    return { specific: String(row.status), order: row.order?.status ?? null };
  }

  for (const kind of Object.keys(STATUSES) as SpecificOrderKind[]) {
    const disagreements: string[] = [];
    const list = edges(kind);
    for (const [from, to] of list) {
      const id = await prisma.$transaction(async (tx) => {
        const id = await makeSpecific(tx, kind, from);
        await syncOrderStatus(tx, kind, id);
        return id;
      });
      const before = await statuses(kind, id);
      if (before.order !== deriveOrderStatus(kind, from)) disagreements.push(`${from} (created): order ${before.order}`);
      await prisma.$transaction((tx) => setStatus(tx, kind, id, to));
      const after = await statuses(kind, id);
      if (after.specific !== to || after.order !== deriveOrderStatus(kind, to)) disagreements.push(`${from}→${to}: order ${after.order}`);
    }
    report(`${kind}: all ${list.length} transitions leave Order.status equal to the derived status`, disagreements.length === 0, disagreements.slice(0, 5).join("; "));
  }

  // A transaction that fails after the specific update leaves both unchanged.
  const rollbackId = await prisma.$transaction(async (tx) => makeSpecific(tx, "LAB", "ORDERED"));
  await prisma.$transaction(async (tx) => {
    await setStatus(tx, "LAB", rollbackId, "CANCELLED");
    throw new Error("abort");
  }).catch(() => undefined);
  const rolled = await statuses("LAB", rollbackId);
  report("A rolled-back transition changes neither status", rolled.specific === "ORDERED" && rolled.order === "ACTIVE", JSON.stringify(rolled));

  // 4. Whole database.
  const bad: string[] = [];
  const check = (kind: SpecificOrderKind, rows: { id: string; status: string; order: { status: string } | null }[]) => {
    for (const r of rows) if (r.order && r.order.status !== deriveOrderStatus(kind, r.status)) bad.push(`${kind} ${r.id}: ${r.status} vs Order ${r.order.status}`);
    return rows.length;
  };
  const sel = { where: { orderId: { not: null } }, select: { id: true, status: true, order: { select: { status: true } } } } as const;
  const n = check("MEDICATION", await prisma.medicationOrder.findMany(sel))
    + check("LAB", await prisma.labOrder.findMany(sel))
    + check("IMAGING", await prisma.imagingOrder.findMany(sel))
    + check("REFERRAL", await prisma.referral.findMany(sel));
  report(`No order in the database has disagreeing statuses (${n} with an envelope)`, bad.length === 0, bad.slice(0, 5).join("; "));

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
