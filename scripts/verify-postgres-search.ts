/**
 * Postgres cutover: proves user-typed search is case-insensitive on
 * PostgreSQL. SQLite's LIKE ignored ASCII case; Postgres does not, and a
 * bare `{ contains: q }` silently stopped matching "rohit" for "Rohit"
 * (docs/POSTGRES_CUTOVER_REPORT.md, F2). Each search is exercised through
 * the same function or filter its route uses, with the query in exact,
 * lower and upper case; all three must return the same rows.
 *
 * Also checks that item search stays facility-scoped.
 *
 * Read-only against seeded data, so safe to re-run.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-search.ts
 */
import { PrismaClient } from "@prisma/client";
import { patientSearchWhere } from "../src/lib/hospital/patientSearch";
import { listItems } from "../src/lib/hospital/inventory/items";
import { SyntheticCaseProvider } from "../src/lib/clinical/providers/syntheticCaseProvider";
import { textContains } from "../src/lib/search";
import { invoiceListWhere } from "../src/lib/hospital/billing/invoices";

const prisma = new PrismaClient();

let pass = 0;
let fail = 0;

function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

/** Runs `search` with exact, lower and upper case; all must find the same non-empty set. */
async function caseInsensitive(name: string, term: string, search: (q: string) => Promise<string[]>) {
  const [exact, lower, upper] = await Promise.all([search(term), search(term.toLowerCase()), search(term.toUpperCase())]);
  const same = (a: string[]) => a.length === exact.length && a.every((id) => exact.includes(id));
  report(
    `${name}: "${term}" matches in any case`,
    exact.length > 0 && same(lower) && same(upper),
    `exact=${exact.length} lower=${lower.length} upper=${upper.length}`
  );
}

async function main() {
  const facility = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Medical Centre" } });

  // Hospital OS patient search (GET /api/hospital/patients).
  const patient = await prisma.patient.findFirstOrThrow({ where: { facilityId: facility.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const findPatients = async (q: string) =>
    (await prisma.patient.findMany({ where: patientSearchWhere(facility.id, q), select: { id: true } })).map((p) => p.id);
  await caseInsensitive("Patient search by name", patient.fullName.split(" ")[0], findPatients);
  await caseInsensitive("Patient search by UHID", patient.uhid, findPatients);

  // Inventory item search (GET /api/hospital/inventory/items).
  const item = await prisma.item.findFirstOrThrow({ where: { facilityId: facility.id, category: "MEDICATION" }, orderBy: [{ name: "asc" }, { id: "asc" }] });
  const findItems = async (q: string) => (await listItems(prisma, { facilityId: facility.id, search: q })).map((i) => i.id);
  await caseInsensitive("Inventory item search", item.name.split(" ")[0], findItems);

  // Search must stay inside the caller's facility (plus global items). A
  // second `OR` for the search once replaced the facility scope.
  const searched = await listItems(prisma, { facilityId: facility.id, search: item.name.split(" ")[0] });
  const foreign = searched.filter((i) => i.facilityId !== null && i.facilityId !== facility.id);
  report("Inventory item search never returns another facility's items", searched.length > 0 && foreign.length === 0, `returned=${searched.length} foreign=${foreign.length}`);

  // Scholar case library search.
  const provider = new SyntheticCaseProvider();
  const findCases = async (q: string) => (await provider.listCases({ query: q })).map((c) => c.id);
  await caseInsensitive("Case library search", "Chest", findCases);

  // Invoice-number search (GET /api/hospital/invoices uses textContains).
  const invoice = await prisma.invoice.findFirstOrThrow({ where: { facilityId: facility.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const findInvoices = async (q: string) =>
    (await prisma.invoice.findMany({ where: { facilityId: facility.id, invoiceNumber: textContains(q) }, select: { id: true } })).map((i) => i.id);
  await caseInsensitive("Invoice number search", invoice.invoiceNumber!, findInvoices);

  // The invoice list's `total` must count what the page lists, search included
  // (it once ignored invoiceNumber and counted every invoice in the facility).
  const where = invoiceListWhere(facility.id, { invoiceNumber: invoice.invoiceNumber!.toLowerCase() });
  const [listed, total, all] = await Promise.all([
    prisma.invoice.findMany({ where, select: { id: true } }),
    prisma.invoice.count({ where }),
    prisma.invoice.count({ where: { facilityId: facility.id } }),
  ]);
  report("Invoice list total counts only invoices matching the number search", total === listed.length && total < all, `listed=${listed.length} total=${total} facility=${all}`);

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
