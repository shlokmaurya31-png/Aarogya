/**
 * Tenancy sweep: every hospital route, over real HTTP, as every role, never
 * returns or touches another tenant's records.
 *
 * Builds the app (unless --no-build), starts `next start` on a free port
 * against DATABASE_URL, and logs in as:
 *   - one user per hospital role in each of two facilities (Pune / Noida, one
 *     organization; each a member of exactly one facility, not an org admin),
 *   - an organization admin of that organization (sees both facilities, must
 *     never see a third organization),
 *   - a platform admin (sees every tenant by design: coverage only).
 * A third tenant, a facility in a separate organization, holds the rows an
 * organization admin must never see.
 *
 * Data: prisma/seedData/tenancyFixtures.ts guarantees a row of every model a
 * route addresses in each of the three tenants, so no route is skipped for
 * lack of data. Ownership is derived from the schema (facilityId, else
 * organizationId, else a required tenant-owned parent).
 *
 * Checks:
 *   1. Every static GET route: plain; with every query parameter it reads
 *      filled with own-tenant values (every enumerated value of kind/view/...);
 *      with id parameters set to the other tenant's ids; with
 *      ?facilityId=<other facility>. No response may contain an id the other
 *      tenant owns. Every route must answer 2xx to at least one actor.
 *   2. Every dynamic route, every method: the 404 rule. An unknown id and the
 *      other tenant's id get the identical answer: 404 (or a 400 / the role's
 *      missing-permission 403 that comes before the lookup); never 2xx, 500 or
 *      a record-level 403. Own-tenant GETs are leak-checked too.
 *   3. Idempotency keys can't replay another facility's payment or refund.
 *   4. Medication-link scopes per role (GLOBAL / ORGANIZATION / FACILITY),
 *      audited.
 *   5. Organization-level rows (facilityId NULL, organizationId set; D6
 *      workflow tasks) count as the organization's: a facility user of another
 *      organization never receives one, and the task route answers 404.
 *   6. Phase 0 — the PERSON segment: person-scoped rows (Person, accounts,
 *      contacts, identifiers, consents, access log, documents, merge
 *      requests and records) belong to no tenant; no hospital route returns
 *      one to any staff or organization actor. Week 4b: the AI index's and AI
 *      interactions' PERSON-owned rows too.
 * A route that is not probed and not on the documented allowlist fails the
 * gate.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-tenancy-sweep.ts [--no-build]
 */
import "./lib/gateBootstrap";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { ItemCategory, Prisma, Role, UnitOfMeasure } from "@prisma/client";
import { prisma } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth/password";
import { ALL_SECTIONS } from "../src/lib/hospital-os/command-center/authz";
import { DRILLDOWN_KINDS } from "../src/lib/hospital-os/command-center/drilldowns";
import { ABDM_CALLBACK_PATHS } from "../src/lib/hospital/interoperability/abdm/contract";
import { WORKFLOW_TEMPLATES } from "../src/lib/workflow-builder/templates";
import { listRegistry } from "../src/lib/config/registry";
import { ensureFixture, ownershipWhere, type Tenant } from "../prisma/seedData/tenancyFixtures";
import { startServer, loginAs } from "./lib/appServer";
import { ensurePrimaryMembership } from "../prisma/seedData/staffMembership";
import { MIXED_OWNER_MODELS, PERSON_SCOPED_MODELS } from "../src/lib/person/tenancy";

const ROOT = path.resolve(__dirname, "..");
const API_ROOT = path.join(ROOT, "src", "app", "api", "hospital");
const FACILITIES = { pune: "fac-amc-pune", noida: "fac-amc-noida" } as const;
type Site = keyof typeof FACILITIES;
const PASSWORD = "TenancySweep@123";
const MARKER = "Tenancysweep";
const HOSPITAL_ROLES: Role[] = [
  Role.HOSPITAL_ADMIN, Role.DOCTOR, Role.NURSE, Role.LAB_TECHNICIAN, Role.RADIOLOGY_TECH,
  Role.PHARMACIST, Role.BILLING_STAFF, Role.PROCUREMENT_OFFICER, Role.FRONT_DESK,
];
const SEARCH_PARAMS = /^(q|query|search|term|name|uhid|phone|mobile|mrn|invoiceNumber|sku|code|keyword)$/;

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok() { pass++; }
function bad(label: string) { fail++; failures.push(label); console.log(`  ✗ ${label}`); }

// ── data ────────────────────────────────────────────────────────────────

const sweepEmail = (site: Site, role: Role) => `tenancy-sweep-${site}-${role.toLowerCase().replace(/_/g, "-")}@sweep.aarogya`;

const ORG_ADMIN_EMAIL = "tenancy-sweep-org-admin@sweep.aarogya";
const OTHER_ORG_ADMIN_EMAIL = "tenancy-sweep-other-org-admin@sweep.aarogya";
const PLATFORM_ADMIN_EMAIL = "tenancy-sweep-platform-admin@sweep.aarogya";
const OTHER_ORG_ID = "org-tenancy-sweep-other";
const OTHER_FACILITY_ID = "fac-tenancy-sweep-other";
const GLOBAL_MED_SKU = "SWEEP-GLOBAL-MED";

/** Users for the medication-link scope checks, plus a global catalog item. */
async function seedLinkActors(password: string) {
  const org = (await prisma.facility.findUniqueOrThrow({ where: { id: FACILITIES.pune } })).organizationId;
  const other = await prisma.organization.upsert({ where: { id: OTHER_ORG_ID }, update: {}, create: { id: OTHER_ORG_ID, name: "Tenancy Sweep Other Org" } });
  const upsertUser = (email: string, role: Role) =>
    prisma.user.upsert({ where: { email }, update: { passwordHash: password, role }, create: { email, displayName: email, role, passwordHash: password } });
  const orgAdmin = await upsertUser(ORG_ADMIN_EMAIL, Role.HOSPITAL_ADMIN);
  await prisma.organizationMembership.upsert({
    where: { userId_organizationId: { userId: orgAdmin.id, organizationId: org } },
    update: { isAdmin: true }, create: { userId: orgAdmin.id, organizationId: org, isAdmin: true },
  });
  // The org admin works at Pune (a staff profile gives facility routes a home
  // facility) and administers the whole organization.
  await prisma.hospitalStaffProfile.upsert({
    where: { userId: orgAdmin.id }, update: { status: "ACTIVE" },
    create: { userId: orgAdmin.id, displayRole: "Tenancy sweep org admin", status: "ACTIVE" },
  });
  await ensurePrimaryMembership(prisma, orgAdmin.id, FACILITIES.pune, { isAdmin: true });
  // The third tenant: a facility in a separate organization.
  await prisma.facility.upsert({
    where: { id: OTHER_FACILITY_ID }, update: {},
    create: { id: OTHER_FACILITY_ID, name: "Tenancy Sweep Other Facility", organizationId: other.id },
  });
  const otherAdmin = await upsertUser(OTHER_ORG_ADMIN_EMAIL, Role.HOSPITAL_ADMIN);
  await prisma.organizationMembership.upsert({
    where: { userId_organizationId: { userId: otherAdmin.id, organizationId: other.id } },
    update: { isAdmin: true }, create: { userId: otherAdmin.id, organizationId: other.id, isAdmin: true },
  });
  await upsertUser(PLATFORM_ADMIN_EMAIL, Role.AAROGYA_ADMIN);
  await prisma.item.upsert({
    where: { sku: GLOBAL_MED_SKU }, update: { active: true },
    create: { sku: GLOBAL_MED_SKU, facilityId: null, name: `${MARKER} Global Medication`, category: ItemCategory.MEDICATION, baseUnit: UnitOfMeasure.TABLET },
  });
}

async function seedSweepData() {
  const password = await hashPassword(PASSWORD);
  await seedLinkActors(password);
  for (const site of Object.keys(FACILITIES) as Site[]) {
    const facilityId = FACILITIES[site];
    const facility = await prisma.facility.findUniqueOrThrow({ where: { id: facilityId } });
    for (const role of HOSPITAL_ROLES) {
    const email = sweepEmail(site, role);
    const user = await prisma.user.upsert({
      where: { email },
      update: { passwordHash: password, role },
      create: { email, displayName: `Tenancy Sweep ${site} ${role}`, role, passwordHash: password },
    });
    await prisma.hospitalStaffProfile.upsert({
      where: { userId: user.id },
      update: { status: "ACTIVE" },
      create: { userId: user.id, displayRole: `Tenancy sweep ${role}`, status: "ACTIVE" },
    });
    await ensurePrimaryMembership(prisma, user.id, facilityId, { isAdmin: role === Role.HOSPITAL_ADMIN });
    // A plain (non-admin) org member: org admins legitimately see every facility.
    await prisma.organizationMembership.upsert({
      where: { userId_organizationId: { userId: user.id, organizationId: facility.organizationId } },
      update: { isAdmin: false },
      create: { userId: user.id, organizationId: facility.organizationId, isAdmin: false },
    });
    }
    // Marker rows that every search below matches, in BOTH facilities.
    await prisma.patient.upsert({
      where: { uhid: `SWEEP-${site.toUpperCase()}-1` },
      update: {},
      create: { uhid: `SWEEP-${site.toUpperCase()}-1`, facilityId, fullName: `${MARKER} Patient ${site}`, sex: "F" },
    });
    await prisma.item.upsert({
      where: { sku: `SWEEP-${site.toUpperCase()}-ITEM` },
      update: {},
      create: { sku: `SWEEP-${site.toUpperCase()}-ITEM`, facilityId, name: `${MARKER} Gauze ${site}`, category: ItemCategory.CONSUMABLE, baseUnit: UnitOfMeasure.PIECE },
    });
  }
}

type TenantKey = "pune" | "noida" | "other";
const MODEL_NAMES = Prisma.dmmf.datamodel.models
  .filter((m) => m.fields.some((f) => f.name === "id" && f.type === "String"))
  .map((m) => m.name);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const delegate = (model: string): any => (prisma as any)[model[0].toLowerCase() + model.slice(1)];

/** Models with an optional facilityId and an organizationId: a row may belong to the organization only. */
const ORG_LEVEL_MODELS = new Set(Prisma.dmmf.datamodel.models
  .filter((m) => m.fields.some((f) => f.name === "facilityId" && !f.isRequired) && m.fields.some((f) => f.name === "organizationId"))
  .map((m) => m.name));
const ORG_TASK_ID = "tsw-org-level-task-other";

/** An organization-level workflow task (no facility) in the other organization. */
async function seedOrgLevelTask() {
  const def = await prisma.workflowDefinition.findFirstOrThrow({ where: { organizationId: null, currentVersionId: { not: null } }, orderBy: { key: "asc" } });
  const inst = await prisma.workflowInstance.upsert({
    where: { idempotencyKey: `${ORG_TASK_ID}:instance` }, update: {},
    create: {
      workflowDefinitionId: def.id, workflowVersionId: def.currentVersionId!, triggerEventId: `${ORG_TASK_ID}:event`, idempotencyKey: `${ORG_TASK_ID}:instance`,
      organizationId: OTHER_ORG_ID, aggregateType: "INVOICE", aggregateId: ORG_TASK_ID, status: "WAITING", correlationId: ORG_TASK_ID,
    },
  });
  await prisma.task.upsert({
    where: { id: ORG_TASK_ID }, update: {},
    create: { id: ORG_TASK_ID, source: "WORKFLOW", organizationId: OTHER_ORG_ID, workflowInstanceId: inst.id, type: "COLLECTIONS_FOLLOWUP", title: `${MARKER} org-level task`, idempotencyKey: ORG_TASK_ID },
  });
}

interface Owned {
  /** Rows the tenant's FACILITY owns (facilityId, or a facility-owned parent). */
  facility: Map<string, string>;
  /** Rows the tenant's ORGANIZATION owns (organizationId, no facilityId). */
  org: Map<string, string>;
  /** Probe ids per model, including the Facility and Organization rows themselves. */
  byModel: Map<string, string[]>;
}

async function ownedRows(t: Tenant): Promise<Owned> {
  const out: Owned = { facility: new Map(), org: new Map(), byModel: new Map([["Facility", [t.facilityId]], ["Organization", [t.organizationId]]]) };
  for (const model of MODEL_NAMES) {
    if (model === "Facility" || model === "Organization") continue;
    const where = ownershipWhere(model, t);
    if (!where) continue;
    const rows: { id: string }[] = await delegate(model).findMany({ where, select: { id: true }, orderBy: { id: "asc" } });
    const orgLevel = "organizationId" in where;
    for (const r of rows) (orgLevel ? out.org : out.facility).set(r.id, model);
    if (rows.length) out.byModel.set(model, rows.map((r) => r.id));
    // Rows with no facility that belong to the organization (an org-level workflow task).
    if (!orgLevel && ORG_LEVEL_MODELS.has(model)) {
      const orgRows: { id: string }[] = await delegate(model).findMany({ where: { facilityId: null, organizationId: t.organizationId }, select: { id: true } });
      for (const r of orgRows) out.org.set(r.id, model);
    }
  }
  return out;
}

// ── routes ──────────────────────────────────────────────────────────────

interface Route { urlPath: string; segments: string[]; params: string[]; methods: string[] }

/** Every hospital route file, with the HTTP methods it exports. */
function getAllRoutes(dir = API_ROOT): Route[] {
  const out: Route[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...getAllRoutes(p));
    else if (name === "route.ts") {
      const src = readFileSync(p, "utf8");
      const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"].filter((m) => new RegExp(`export (async function|const) ${m}\\b`).test(src));
      if (methods.length === 0) continue;
      const rel = path.relative(path.join(ROOT, "src", "app"), path.dirname(p)).split(path.sep);
      const params = [...new Set([...src.matchAll(/\b(?:searchParams|sp|q)\.get\(\s*["'`](\w+)["'`]/g)].map((m) => m[1]))];
      out.push({ urlPath: "/" + rel.join("/"), segments: rel, params, methods });
    }
  }
  return out.sort((a, b) => a.urlPath.localeCompare(b.urlPath));
}

const UNKNOWN_ID = "cmtenancysweepunknown00000";

/** Dynamic segments that are not record ids: probed with every valid value. */
const STATIC_SEGMENTS: Record<string, string[]> = {
  "section/[key]": [...ALL_SECTIONS],
  "callback/[kind]": Object.keys(ABDM_CALLBACK_PATHS),
  "webhooks/[provider]": ["FAKE", "RAZORPAY"],
  "templates/[id]": WORKFLOW_TEMPLATES.map((t) => t.id),
};

/**
 * The model a record-id segment addresses, keyed by the most specific path
 * suffix first ("a/b/[id]", then "b/[id]"). Curated: the URL makes each one
 * unambiguous to a reader, while guessing from names was wrong for several
 * (inventory/locations, enterprise/events).
 */
const SEGMENT_MODELS: Record<string, string> = {
  "facilities/[facilityId]/members/[membershipId]": "FacilityMembership",
  "organizations/[organizationId]/members/[membershipId]": "OrganizationMembership",
  "commercial/billing/invoices/[id]": "BillingInvoice",
  "procurement/invoices/[id]": "SupplierInvoice",
  "interoperability/consents/[id]": "InteropConsent",
  "inventory/requests/[id]": "DepartmentSupplyRequest",
  "pharmacy/requests/[id]": "PharmacyRequest",
  "blood/requests/[id]": "BloodRequest",
  "orders/lab/[id]": "LabOrder",
  "orders/imaging/[id]": "ImagingOrder",
  "orders/medication/[id]": "MedicationOrder",
  "lab/calibration/[id]": "LabCalibrationRecord",
  "lab/external/[id]": "ExternalLabReferral",
  "lab/qc/[id]": "LabQcRecord",
  "trace/lot/[lotId]": "ItemLot",
  "trace/patient/[patientId]": "Patient",
  "billing/[encounterId]": "Encounter",
  "charges/[chargeId]": "Charge",
  "holds/[holdId]": "DischargeHold",
  "packages/[id]": "PackageDefinition",
  "adjustments/[id]": "FinancialAdjustment",
  "compatibility/[id]": "BloodCompatibilityTest",
  "issues/[id]": "BloodIssue",
  "reactions/[id]": "TransfusionReaction",
  "reservations/[id]": "BloodReservation",
  "transfusions/[id]": "Transfusion",
  "units/[id]": "BloodUnit",
  "resuscitations/[id]": "EdResuscitation",
  "events/[eventId]": "DomainEventOutbox",
  "organization/[organizationId]": "Organization",
  "organizations/[organizationId]": "Organization",
  "facilities/[facilityId]": "Facility",
  "drafts/[id]": "WorkflowBuilderDraft",
  "workflow-instances/[instanceId]": "WorkflowInstance",
  "workflows/[workflowId]": "WorkflowDefinition",
  "plans/[planId]": "SubscriptionPlan",
  "invoices/[id]": "Invoice",
  "exchanges/[id]": "HealthInformationExchange",
  "identifiers/[id]": "ExternalIdentifier",
  "serials/[id]": "InventorySerial",
  "notifications/[id]": "Notification",
  "ambulance-trips/[id]": "AmbulanceTrip",
  "ambulances/[id]": "Ambulance",
  "diet-orders/[id]": "DietOrder",
  "downtime/[id]": "AssetDowntime",
  "equipment/[id]": "BiomedicalEquipment",
  "housekeeping/[id]": "HousekeepingRequest",
  "infection/[id]": "InfectionIncident",
  "maintenance/[id]": "MaintenanceRequest",
  "meals/[id]": "Meal",
  "preventive/[id]": "PreventiveMaintenance",
  "transport/[id]": "PatientTransportRequest",
  "report/[reportId]": "ImagingReport",
  "result/[resultId]": "LabResult",
  "surgeries/[id]": "Surgery",
  "formulary/[id]": "FormularyEntry",
  "recall/[id]": "MedicationRecall",
  "returns/[id]": "MedicationReturn",
  "contracts/[id]": "SupplierContract",
  "quotations/[id]": "RfqQuotation",
  "rfq/[id]": "Rfq",
  "requisitions/[id]": "PurchaseRequisition",
  "incidents/[id]": "QualityIncident",
  "rca/[id]": "RootCauseAnalysis",
  "claims/[id]": "Claim",
  "payments/[id]": "Payment",
  "refunds/[id]": "Refund",
  "queue/[id]": "QueueEntry",
  "patient-access/[id]": "PatientAccessSession",
  "doctors/[staffId]": "HospitalStaffProfile",
  "handoffs/[id]": "ClinicalHandoff",
  "documents/[id]": "ClinicalDocument",
  "medication-safety-warnings/[id]": "MedicationSafetyWarning",
  "assignments/[id]": "NursingAssignment",
  "coverage/[id]": "PatientCoverage",
  "preauth/[id]": "PreAuthorization",
  "payers/[id]": "Payer",
  "locations/[id]": "StockLocation",
  "lots/[id]": "ItemLot",
  "devices/[id]": "IcuDevice",
  "infusions/[id]": "IcuInfusion",
  "encounters/[id]": "Encounter",
  "diagnoses/[id]": "Diagnosis",
  "patients/[id]": "Patient",
  "admissions/[id]": "Admission",
  "items/[id]": "Item",
  "suppliers/[id]": "Supplier",
  "purchase-orders/[id]": "PurchaseOrder",
  "goods-receipts/[id]": "GoodsReceipt",
  "transfers/[id]": "StockTransfer",
  "waste/[id]": "WasteRecord",
  "appointments/[id]": "Appointment",
  "referrals/[id]": "Referral",
  "care-plans/[id]": "CarePlan",
  "tasks/[id]": "Task",
  "transfer-requests/[id]": "TransferRequest",
  "admission-requests/[id]": "AdmissionRequest",
  "stocktakes/[id]": "StockTake",
  "tariffs/[id]": "Tariff",
  "beds/[id]": "Bed",
  "consents/[id]": "InteropConsent",
  "patient-link-requests/[id]": "PatientLinkRequest",
  "person-links/[id]": "PersonPatientLink",
  "person-documents/[id]": "PersonDocument",
  // Week 4c: person-scoped; staff reach them only as requester or recipient.
  "access-requests/[id]": "AccessRequest",
  "shares/[id]": "RecordShare",
};

type SegmentTarget = { kind: "record"; model: string } | { kind: "static"; values: string[] } | { kind: "unmapped" };

/** What segment `i` of `route` addresses. */
function segmentTarget(route: Route, i: number): SegmentTarget {
  const segs = route.segments;
  for (const n of [4, 3, 2]) {
    if (i - n + 1 < 0) continue;
    const key = segs.slice(i - n + 1, i + 1).join("/");
    if (STATIC_SEGMENTS[key]) return { kind: "static", values: STATIC_SEGMENTS[key] };
    if (SEGMENT_MODELS[key]) return { kind: "record", model: SEGMENT_MODELS[key] };
  }
  const m = /^\[(\w+)\]$/.exec(segs[i])!;
  const byName = MODEL_NAMES.find((x) => x.toLowerCase() === m[1].replace(/Id$/, "").toLowerCase());
  if (m[1] !== "id" && byName) return { kind: "record", model: byName };
  return { kind: "unmapped" };
}

/** Routes that genuinely can't be probed the normal way, with the reason. */
const ALLOWLIST: Record<string, string> = {
  "GET /api/hospital/interoperability/abdm/callback/[kind]":
    "GET deliberately answers 405: ABDM callbacks are POSTs from the gateway. The POST is probed for every callback kind.",
  "GET /api/hospital/interoperability/fhir/export":
    "GET deliberately answers 405: an export is an authorization decision and must be a POST. The POST is covered by the leak checks.",
};

/** Query-parameter models: own-tenant values, or the other tenant's for the foreign variant. */
const PARAM_MODELS: Record<string, string> = {
  patientId: "Patient", encounterId: "Encounter", admissionId: "Admission", staffId: "HospitalStaffProfile",
  doctorStaffId: "HospitalStaffProfile", nurseStaffId: "HospitalStaffProfile", itemId: "Item", locationId: "StockLocation",
  supplierId: "Supplier", organizationId: "Organization", departmentId: "Department", workflowId: "WorkflowDefinition",
  specimenId: "Specimen", wardId: "Ward", bedId: "Bed", lotId: "ItemLot", claimId: "Claim", invoiceId: "Invoice",
  payerId: "Payer", unitId: "BloodUnit", requestId: "BloodRequest", surgeryId: "Surgery", operatingTheatreId: "OperatingTheatre",
};
const TODAY = new Date().toISOString().slice(0, 10);
const DATE_PARAMS: Record<string, string> = {
  from: "2000-01-01", to: "2100-01-01", dateFrom: "2000-01-01", dateTo: "2100-01-01", fromISO: "2000-01-01T00:00:00Z",
  toISO: "2100-01-01T00:00:00Z", since: "2000-01-01", until: "2100-01-01", start: "2000-01-01", end: "2100-01-01",
  date: TODAY, day: TODAY,
};

/** Values an enumerated parameter can take: its route's `case "..."` labels, or a known list. */
function enumValues(route: Route, param: string): string[] {
  if (param === "kind" && route.urlPath.endsWith("/drilldown")) return [...DRILLDOWN_KINDS];
  if (param === "key") return listRegistry().exact.slice(0, 3).map((e) => e.key);
  if (param === "scope") return ["ORGANIZATION", "FACILITY"];
  const src = readFileSync(path.join(ROOT, "src", "app", ...route.segments, "route.ts"), "utf8");
  const v = new RegExp(`const (\\w+) = \\w+\\.get\\("${param}"\\)`).exec(src)?.[1];
  if (!v) return [];
  const sw = new RegExp(`switch \\(${v}\\) \\{([\\s\\S]*?)\\n\\s{4}\\}`).exec(src);
  return sw ? [...sw[1].matchAll(/case "([^"]+)"/g)].map((x) => x[1]) : [];
}

// ── server ──────────────────────────────────────────────────────────────

const loginEmail = (base: string, email: string) => loginAs(base, email, PASSWORD);
const login = (base: string, site: Site, role: Role) => loginEmail(base, sweepEmail(site, role));

/** Runs `tasks` with at most `limit` in flight. */
async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < tasks.length) {
        const i = next++;
        results[i] = await tasks[i]();
      }
    })
  );
  return results;
}

// ── sweep ───────────────────────────────────────────────────────────────

/** Ids in `text` (JSON or not) that the other facility owns. */
function leaks(text: string, foreign: Map<string, string>): string[] {
  const hits = new Set<string>();
  for (const token of text.match(/[A-Za-z0-9_-]{8,}/g) ?? []) {
    const table = foreign.get(token);
    if (table) hits.add(`${table}:${token}`);
  }
  return [...hits];
}

/**
 * Medication-link scopes: GLOBAL = platform admin only, ORGANIZATION = that
 * org's admin only, FACILITY = that facility's inventory manager. Outside the
 * scope's tenant → 404; inside it without the right → 403. Every GLOBAL and
 * ORGANIZATION link writes an audit event.
 */
async function medicationLinkSection(base: string) {
  console.log("\nMedication link scopes:");
  const run = Date.now().toString(36);
  const org = (await prisma.facility.findUniqueOrThrow({ where: { id: FACILITIES.pune } })).organizationId;
  const globalItem = await prisma.item.findUniqueOrThrow({ where: { sku: GLOBAL_MED_SKU } });
  const noidaItem = await prisma.item.findFirstOrThrow({ where: { facilityId: FACILITIES.noida, category: "MEDICATION", active: true }, orderBy: [{ name: "asc" }, { id: "asc" }] }).catch(() =>
    prisma.item.create({ data: { sku: `SWEEP-NOIDA-MED-${run}`, facilityId: FACILITIES.noida, name: `${MARKER} Noida Medication`, category: ItemCategory.MEDICATION, baseUnit: UnitOfMeasure.TABLET } })
  );
  const actors = {
    "noida inventory manager": await login(base, "noida", Role.HOSPITAL_ADMIN),
    "noida doctor": await login(base, "noida", Role.DOCTOR),
    "org admin": await loginEmail(base, ORG_ADMIN_EMAIL),
    "other org's admin": await loginEmail(base, OTHER_ORG_ADMIN_EMAIL),
    "platform admin": await loginEmail(base, PLATFORM_ADMIN_EMAIL),
  };
  type Actor = keyof typeof actors;
  let n = 0;
  const attempt = async (actor: Actor, body: Record<string, unknown>, want: number, label: string) => {
    const res = await fetch(base + "/api/hospital/inventory/medication-links", {
      method: "POST",
      headers: { cookie: actors[actor], "content-type": "application/json" },
      body: JSON.stringify({ drugName: `SweepLinkDrug-${run}-${++n}`, ...body }),
    });
    const text = await res.text();
    if (res.status === want) { ok(); console.log(`  ✓ ${actor}: ${label} → ${want}`); }
    else bad(`medication link: ${actor} ${label} → HTTP ${res.status}, expected ${want} (${text.slice(0, 120)})`);
    return res.status === 200 ? (JSON.parse(text).link as { id: string }) : null;
  };

  // FACILITY
  await attempt("noida inventory manager", { scope: "FACILITY", facilityId: FACILITIES.noida, itemId: noidaItem.id }, 200, "FACILITY link at own facility");
  await attempt("noida inventory manager", { scope: "FACILITY", facilityId: FACILITIES.pune, itemId: globalItem.id }, 404, "FACILITY link at another facility");
  await attempt("noida doctor", { scope: "FACILITY", facilityId: FACILITIES.noida, itemId: noidaItem.id }, 403, "FACILITY link without inventory:item:manage");
  // ORGANIZATION
  await attempt("noida inventory manager", { scope: "ORGANIZATION", organizationId: org, itemId: globalItem.id }, 403, "ORGANIZATION link as a non-admin member");
  await attempt("other org's admin", { scope: "ORGANIZATION", organizationId: org, itemId: globalItem.id }, 404, "ORGANIZATION link for an org it doesn't belong to");
  await attempt("org admin", { scope: "ORGANIZATION", organizationId: org, itemId: noidaItem.id }, 400, "ORGANIZATION link to one facility's item");
  const orgLink = await attempt("org admin", { scope: "ORGANIZATION", organizationId: org, itemId: globalItem.id }, 200, "ORGANIZATION link to a global item");
  // GLOBAL
  await attempt("noida inventory manager", { scope: "GLOBAL", itemId: globalItem.id }, 403, "GLOBAL link");
  await attempt("org admin", { scope: "GLOBAL", itemId: globalItem.id }, 403, "GLOBAL link");
  await attempt("platform admin", { scope: "GLOBAL", itemId: noidaItem.id }, 400, "GLOBAL link to one facility's item");
  const globalLink = await attempt("platform admin", { scope: "GLOBAL", itemId: globalItem.id }, 200, "GLOBAL link to a global item");

  // Every GLOBAL / ORGANIZATION link change is audited.
  for (const [label, link, scope] of [["ORGANIZATION", orgLink, "ORGANIZATION"], ["GLOBAL", globalLink, "GLOBAL"]] as const) {
    if (!link) continue;
    const audit = await prisma.auditEvent.findFirst({ where: { type: "hospital.inventory.medicationLinked", detail: { path: ["linkId"], equals: link.id } } });
    const okAudit = audit !== null && (audit.detail as { scope?: string } | null)?.scope === scope;
    if (okAudit) { ok(); console.log(`  ✓ ${label} link wrote an audit event`); }
    else bad(`medication link: the ${label} link wrote no audit event with scope ${scope}`);
  }

  // Both facilities resolve through the org and global links.
  for (const site of ["pune", "noida"] as Site[]) {
    const res = await fetch(base + "/api/hospital/inventory/medication-links", { headers: { cookie: await login(base, site, Role.PHARMACIST) } }); // PHARMACIST holds inventory:item:view
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !Array.isArray(json.links)) { bad(`medication link: ${site} list → HTTP ${res.status} ${JSON.stringify(json).slice(0, 160)}`); continue; }
    const ids = (json.links as { id: string }[]).map((l) => l.id);
    const visible = [orgLink, globalLink].every((l) => !l || ids.includes(l.id));
    if (visible) { ok(); console.log(`  ✓ ${site} sees the organization and global links`); }
    else bad(`medication link: ${site} does not see the organization/global links`);
  }
}

/** Idempotency keys are client-supplied and globally unique; replay must stay in-facility. */
async function idempotencySection(base: string, owned: Record<Site, Map<string, string>>) {
  console.log("\nIdempotency keys across facilities (unique per facility, §8.4):");
  const cookies = { pune: await login(base, "pune", Role.HOSPITAL_ADMIN), noida: await login(base, "noida", Role.HOSPITAL_ADMIN) };
  const post = async (site: Site, url: string, body: unknown) => {
    const res = await fetch(base + url, { method: "POST", headers: { cookie: cookies[site], "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, text: await res.text() };
  };
  const encounter = async (site: Site) =>
    (await prisma.encounter.findFirstOrThrow({ where: { facilityId: FACILITIES[site] }, orderBy: [{ registeredAt: "asc" }, { id: "asc" }], select: { id: true } })).id;
  const run = Date.now().toString(36);

  const payKey = `sweep-pay-${run}`;
  const punePay = await post("pune", "/api/hospital/payments", { encounterId: await encounter("pune"), amountMinor: 1000, method: "CASH", idempotencyKey: payKey });
  if (punePay.status !== 200) bad(`pune payment setup → HTTP ${punePay.status} ${punePay.text.slice(0, 200)}`);
  const punePaymentId = JSON.parse(punePay.text).payment?.id as string | undefined;
  const replay = await post("noida", "/api/hospital/payments", { encounterId: await encounter("noida"), amountMinor: 1000, method: "CASH", idempotencyKey: payKey });
  // §8.4: keys are unique per facility, so noida's use of the same key is its
  // own payment — never pune's row, and pune's row is untouched.
  const payLeak = punePaymentId && replay.text.includes(punePaymentId);
  const noidaOwn = replay.status === 200 ? (JSON.parse(replay.text).payment as { id: string; facilityId: string } | undefined) : undefined;
  const pairCount = await prisma.payment.count({ where: { idempotencyKey: payKey } });
  if (!payLeak && noidaOwn && noidaOwn.id !== punePaymentId && noidaOwn.facilityId === FACILITIES.noida && pairCount === 2) {
    ok(); console.log("  ✓ payment: pune's key from noida → noida's own payment (keys are per facility), no pune data");
  } else bad(`payment: pune's idempotency key reused by noida → HTTP ${replay.status}${payLeak ? " and returned pune's payment" : ""} (rows with the key: ${pairCount})`);

  const refundKey = `sweep-refund-${run}`;
  let puneRefundId: string | undefined;
  if (punePaymentId) {
    const r = await post("pune", `/api/hospital/payments/${punePaymentId}/refund`, { amountMinor: 100, reason: "tenancy sweep", idempotencyKey: refundKey });
    if (r.status !== 200) bad(`pune refund setup → HTTP ${r.status} ${r.text.slice(0, 200)}`);
    else puneRefundId = JSON.parse(r.text).refund?.id;
  }
  const noidaPay = await post("noida", "/api/hospital/payments", { encounterId: await encounter("noida"), amountMinor: 1000, method: "CASH", idempotencyKey: `sweep-pay-noida-${run}` });
  const noidaPaymentId = noidaPay.status === 200 ? (JSON.parse(noidaPay.text).payment?.id as string) : undefined;
  if (!noidaPaymentId) bad(`noida payment setup → HTTP ${noidaPay.status} ${noidaPay.text.slice(0, 200)}`);
  else {
    const r = await post("noida", `/api/hospital/payments/${noidaPaymentId}/refund`, { amountMinor: 100, reason: "tenancy sweep", idempotencyKey: refundKey });
    const leaked = leaks(r.text, owned.pune);
    if (puneRefundId && r.text.includes(puneRefundId)) leaked.push(`Refund:${puneRefundId}`);
    const noidaRefund = r.status === 200 ? (JSON.parse(r.text).refund as { id: string; facilityId: string } | undefined) : undefined;
    if (leaked.length === 0 && noidaRefund && noidaRefund.id !== puneRefundId && noidaRefund.facilityId === FACILITIES.noida) {
      ok(); console.log("  ✓ refund: pune's key from noida → noida's own refund (keys are per facility), no pune data");
    } else bad(`refund: pune's idempotency key reused by noida → HTTP ${r.status}${leaked.length ? ` and returned pune rows ${leaked.join(", ")}` : ""}`);
  }
}

interface Actor {
  name: string;
  cookie: string;
  /** The tenant whose rows are "own" for parameters and own-record probes. */
  home: TenantKey;
  /** Ids this actor must never receive; null = platform admin (sees every tenant by design). */
  foreign: Map<string, string> | null;
  /** The tenant whose ids the 404-rule probes use. */
  foreignTenant: TenantKey | null;
  /** Appended as ?facilityId= (a platform admin has no home facility). */
  facilityParam?: string;
}

const merge = (...maps: Map<string, string>[]) => new Map(maps.flatMap((m) => [...m]));

/** Two Persons with a row of every person-scoped model; returns every person-scoped row id (all Persons). */
async function seedPersonSegment(): Promise<Map<string, string>> {
  for (const tag of ["a", "b"]) {
    const email = `tenancy-sweep-person-${tag}@sweep.aarogya`;
    const user = await prisma.user.upsert({ where: { email }, update: {}, create: { email, passwordHash: "x", role: Role.PATIENT, displayName: `${MARKER} person ${tag}` } });
    const acct = await prisma.personAccount.findUnique({ where: { userId: user.id } });
    const personId = acct?.personId ?? (await prisma.person.create({ data: { displayName: `${MARKER} person ${tag}`, accounts: { create: { userId: user.id, role: "OWNER" } } } })).id;
    if (!(await prisma.personContact.count({ where: { personId } }))) await prisma.personContact.create({ data: { personId, kind: "EMAIL", value: email } });
    if (!(await prisma.personIdentifier.count({ where: { personId } }))) await prisma.personIdentifier.create({ data: { personId, system: "ABHA_ADDRESS", valueHash: `sweep-${tag}`, valueLast4: "abcd" } });
    if (!(await prisma.personConsent.count({ where: { personId } }))) await prisma.personConsent.create({ data: { personId, purpose: "SHARE_UPLOADS_WITH_TREATING", decision: "DECLINED", decidedByUserId: user.id } });
    if (!(await prisma.personAccessLogEntry.count({ where: { personId } }))) await prisma.personAccessLogEntry.create({ data: { personId, kind: "PERSON_CREATED" } });
    if (!(await prisma.personDocument.count({ where: { personId } }))) await prisma.personDocument.create({ data: { personId, type: "REPORT", title: `${MARKER} person document ${tag}`, storageRef: `patient-uploads/${personId}/sweep-${tag}`, sha256: "e".repeat(64), uploadedByUserId: user.id } });
  }
  // A merge request and record between the two (person-scoped too).
  const [pa, pb] = await Promise.all(["a", "b"].map(async (tag) => (await prisma.personAccount.findUniqueOrThrow({ where: { userId: (await prisma.user.findUniqueOrThrow({ where: { email: `tenancy-sweep-person-${tag}@sweep.aarogya` } })).id } })).personId));
  if (!(await prisma.personMergeRequest.count({ where: { personId: pa } }))) {
    const req = await prisma.personMergeRequest.create({ data: { personId: pa, sourcePersonId: pb, initiatedByUserId: "sweep", targetCodeHash: "x", sourceCodeHash: "y", expiresAt: new Date(), status: "EXPIRED" } });
    await prisma.personMergeRecord.create({ data: { personId: pa, sourcePersonId: pb, method: "BOTH_ACCOUNTS_PROVEN", requestId: req.id, actorUserId: "sweep", snapshot: {} } });
  }
  // Week 4b — the AI index and AI interactions: their PERSON-owned rows belong to no tenant either.
  if (!(await prisma.ragDocument.count({ where: { personId: pa, ownerType: "PERSON" } }))) {
    const doc = await prisma.ragDocument.create({ data: { ownerType: "PERSON", personId: pa, sourceType: "PATIENT_PROVIDED_RECORD", sourceId: `sweep-${pa}`, sourceVersion: 1, origin: "PATIENT_PROVIDED", contentHash: "sweep", categories: ["UPLOADS"], audience: "PATIENT_VISIBLE", title: `${MARKER} rag document`, recordedAt: new Date(), embeddingModel: "mock-hash-1024", embeddingDim: 1024 } });
    const chunk = await prisma.ragChunk.create({ data: { documentId: doc.id, chunkNo: 0, ownerType: "PERSON", personId: pa, categories: ["UPLOADS"], origin: "PATIENT_PROVIDED", audience: "PATIENT_VISIBLE", sourceType: "PATIENT_PROVIDED_RECORD", sourceId: doc.sourceId, recordedAt: new Date(), context: "[sweep]", text: `${MARKER} rag chunk`, tokenCount: 3 } });
    await prisma.$executeRaw`INSERT INTO "RagEmbedding" ("id", "chunkId", "embeddingModel", "embeddingVersion", "dims", "embedding", "ownerType", "personId") VALUES (${`sweep-emb-${pa}`}, ${chunk.id}, 'mock-hash-1024', 1, 3, '[1,0,0]'::halfvec, 'PERSON', ${pa})`;
    await prisma.aiInteraction.create({ data: { userId: "sweep", role: "PATIENT", personId: pa, mode: "EXPLAIN_REPORT", language: "en", model: "mock", embeddingModel: "mock-hash-1024", embeddingVersion: 1, outcome: "NO_RECORD", latencyMs: 1, metadataExpiresAt: new Date(Date.now() + 365 * 86_400_000) } });
  }
  const rows = new Map<string, string>();
  for (const model of PERSON_SCOPED_MODELS) {
    const found: { id: string }[] = await delegate(model).findMany({ select: { id: true } });
    for (const r of found) rows.set(r.id, model);
  }
  for (const model of MIXED_OWNER_MODELS) {
    const found: { id: string }[] = await delegate(model).findMany({ where: { personId: { not: null }, facilityId: null }, select: { id: true } });
    for (const r of found) rows.set(r.id, model);
  }
  return rows;
}
const isFacilityLevel = (model: string, t: Tenant) => {
  const w = ownershipWhere(model, t);
  return w !== null && !("organizationId" in w) && model !== "Facility" && model !== "Organization";
};
const withParam = (url: string, key: string, value: string) => `${url}${url.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;

async function main() {
  const allRoutes = getAllRoutes();
  await seedSweepData();
  const orgId = (await prisma.facility.findUniqueOrThrow({ where: { id: FACILITIES.pune } })).organizationId;
  const tenants: Record<TenantKey, Tenant> = {
    pune: { facilityId: FACILITIES.pune, organizationId: orgId },
    noida: { facilityId: FACILITIES.noida, organizationId: orgId },
    other: { facilityId: OTHER_FACILITY_ID, organizationId: OTHER_ORG_ID },
  };

  // Every dynamic segment must resolve to a model or a known value list.
  const needed = new Set<string>(Object.values(PARAM_MODELS).concat("Specimen"));
  for (const r of allRoutes) {
    r.segments.forEach((seg, i) => {
      if (!seg.startsWith("[")) return;
      const t = segmentTarget(r, i);
      if (t.kind === "record") needed.add(t.model);
      else if (t.kind === "unmapped") bad(`route segment has no model mapping: ${r.urlPath} ${seg} (add it to SEGMENT_MODELS)`);
    });
  }

  // Fixtures: a row of every needed model in every tenant (untenanted models: one shared row).
  const untenanted = new Map<string, string>();
  for (const model of needed) {
    for (const key of Object.keys(tenants) as TenantKey[]) {
      try {
        const id = await ensureFixture(prisma, model, tenants[key]);
        if (ownershipWhere(model, tenants[key]) === null) untenanted.set(model, id);
      } catch (e) {
        bad(`fixture ${model} in ${key}: ${(e as Error).message}`);
      }
    }
  }
  await seedOrgLevelTask();
  const owned: Record<TenantKey, Owned> = { pune: await ownedRows(tenants.pune), noida: await ownedRows(tenants.noida), other: await ownedRows(tenants.other) };
  console.log(`Owned rows: pune=${owned.pune.facility.size} noida=${owned.noida.facility.size} other=${owned.other.facility.size + owned.other.org.size}; routes: ${allRoutes.length}; models probed: ${needed.size}`);

  // Ids per tenant for one model: the tenant's own rows, or the shared row of an untenanted model.
  const idFor = (model: string, key: TenantKey): string | undefined => owned[key].byModel.get(model)?.[0] ?? untenanted.get(model);
  // Every tenant-owned model a route addresses must have a row in every tenant.
  for (const model of needed) {
    if (untenanted.has(model)) continue;
    for (const key of Object.keys(tenants) as TenantKey[]) {
      if (!owned[key].byModel.get(model)?.length) bad(`fixture: no ${model} row owned by ${key}`);
    }
  }
  const specimenCode = async (key: TenantKey) => {
    const s = await prisma.specimen.findFirst({ where: { facilityId: tenants[key].facilityId }, orderBy: { id: "asc" } });
    return s?.barcode ?? s?.accessionNumber ?? s?.id ?? MARKER;
  };
  // Exports need a workflow with a version: the seeded global templates.
  const versionedWorkflow = (await prisma.workflowDefinition.findFirst({ where: { organizationId: null, currentVersionId: { not: null } }, orderBy: { key: "asc" } }))?.id;
  const codes: Record<TenantKey, string> = { pune: await specimenCode("pune"), noida: await specimenCode("noida"), other: await specimenCode("other") };

  const { base, child } = await startServer();
  const statuses: Record<string, number> = {};
  const serverErrors = new Set<string>();
  const covered = new Set<string>();
  const recordProbed = new Set<string>();
  const ownGetOk = new Set<string>();
  const recordStatuses: Record<string, number> = {};
  try {
    // ── actors ──
    // Phase 0 — the PERSON segment: person-scoped rows belong to no facility or
    // organization, so no hospital route may ever return one, to any staff
    // actor of any tenant. Two Persons with every person-scoped row are seeded.
    const personRows = await seedPersonSegment();
    console.log(`Person-scoped rows (never returned by a hospital route): ${personRows.size}`);
    const actors: Actor[] = [];
    for (const site of ["pune", "noida"] as Site[]) {
      const other: Site = site === "pune" ? "noida" : "pune";
      for (const role of HOSPITAL_ROLES) {
        actors.push({
          name: `${site}/${role}`, cookie: await login(base, site, role), home: site, foreignTenant: other,
          foreign: merge(owned[other].facility, owned.other.facility, owned.other.org, personRows),
        });
      }
    }
    actors.push({ name: "org admin", cookie: await loginEmail(base, ORG_ADMIN_EMAIL), home: "pune", foreignTenant: "other", foreign: merge(owned.other.facility, owned.other.org, personRows) });
    actors.push({ name: "platform admin", cookie: await loginEmail(base, PLATFORM_ADMIN_EMAIL), home: "pune", foreignTenant: null, foreign: null, facilityParam: FACILITIES.pune });

    const send = async (actor: Actor, method: string, url: string) => {
      const target = actor.facilityParam ? withParam(url, "facilityId", actor.facilityParam) : url;
      const res = await fetch(base + target, {
        method,
        headers: { cookie: actor.cookie, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
        ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
      });
      const text = await res.text();
      statuses[res.status] = (statuses[res.status] ?? 0) + 1;
      if (res.status >= 500) serverErrors.add(`${res.status} ${method} ${url} (${actor.name})`);
      let error = "";
      try { error = String(JSON.parse(text).error ?? ""); } catch { /* not JSON */ }
      return { status: res.status, ok: res.ok, text, permission: res.status === 403 && error.startsWith("Missing permission") };
    };
    const leakCheck = (actor: Actor, label: string, r: { ok: boolean; status: number; text: string }) => {
      if (!actor.foreign || !r.ok) return ok();
      const found = leaks(r.text, actor.foreign);
      if (found.length) bad(`${label} as ${actor.name} → HTTP ${r.status} returned ${found.length} foreign row(s): ${found.slice(0, 5).join(", ")}`);
      else ok();
    };

    // ── URL expansion ──
    /** Concrete URLs for a route with record segments filled by `pick` (null if a model has no id). */
    const expand = (route: Route, pick: (model: string) => string | undefined): string[] | null => {
      let urls = [""];
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i];
        if (!seg.startsWith("[")) { urls = urls.map((u) => `${u}/${seg}`); continue; }
        const t = segmentTarget(route, i);
        if (t.kind === "static") { urls = urls.flatMap((u) => t.values.map((v) => `${u}/${encodeURIComponent(v)}`)); continue; }
        if (t.kind === "unmapped") return null;
        const id = pick(t.model);
        if (!id) return null;
        urls = urls.map((u) => `${u}/${id}`);
      }
      return urls;
    };
    const paramVariants = (route: Route, url: string, key: TenantKey, idTenant: TenantKey): string[] => {
      const fixed: [string, string][] = [];
      const enums: [string, string[]][] = [];
      for (const p of route.params) {
        if (p === "facilityId") continue;
        if (p === "workflowId" && idTenant === key && versionedWorkflow) { fixed.push([p, versionedWorkflow]); continue; }
        if (PARAM_MODELS[p]) { const id = idFor(PARAM_MODELS[p], idTenant); if (id) fixed.push([p, id]); continue; }
        if (DATE_PARAMS[p]) { fixed.push([p, DATE_PARAMS[p]]); continue; }
        if (p === "code") { fixed.push([p, codes[idTenant]]); continue; }
        if (SEARCH_PARAMS.test(p)) { fixed.push([p, MARKER]); continue; }
        const values = enumValues(route, p);
        if (values.length) enums.push([p, values]);
      }
      if (fixed.length === 0 && enums.length === 0) return [];
      const head = enums[0];
      const rest = enums.slice(1).map(([p, v]) => [p, v[0]] as [string, string]);
      const combos = head ? head[1].map((v) => [[head[0], v] as [string, string], ...rest]) : [rest];
      return combos.map((c) => `${url}?${new URLSearchParams([...fixed, ...c])}`);
    };

    // ── 1. static (non-record) GET routes ──
    const staticTasks: (() => Promise<void>)[] = [];
    for (const route of allRoutes.filter((r) => r.methods.includes("GET"))) {
      const hasRecord = route.segments.some((s, i) => s.startsWith("[") && segmentTarget(route, i).kind !== "static");
      if (hasRecord) continue;
      for (const url of expand(route, () => undefined) ?? []) {
        for (const actor of actors) {
          const variants: [string, string][] = [["list", url], ...paramVariants(route, url, actor.home, actor.home).map((u) => ["params", u] as [string, string])];
          if (actor.foreignTenant) {
            variants.push(...paramVariants(route, url, actor.home, actor.foreignTenant).map((u) => ["params-foreign", u] as [string, string]));
            variants.push(["cross-facility", withParam(url, "facilityId", tenants[actor.foreignTenant].facilityId)]);
          }
          for (const [kind, u] of variants) {
            staticTasks.push(async () => {
              const r = await send(actor, "GET", u);
              if (r.ok && kind !== "params-foreign" && kind !== "cross-facility") covered.add(route.urlPath);
              leakCheck(actor, `${kind} ${u}`, r);
            });
          }
        }
      }
    }
    await pool(staticTasks, 16);
    console.log(`\nStatic routes: ${staticTasks.length} requests`);

    // ── 2. record routes: the 404 rule + own-record leak check ──
    const recordTasks: (() => Promise<void>)[] = [];
    for (const route of allRoutes) {
      const hasRecord = route.segments.some((s, i) => s.startsWith("[") && segmentTarget(route, i).kind === "record");
      if (!hasRecord) continue;
      for (const actor of actors) {
        // Required query parameters (e.g. slots?date=) so the lookup is reached.
        const qs = (urls: string[] | null) => urls && urls.map((u) => paramVariants(route, u, actor.home, actor.home)[0] ?? u);
        const own = qs(expand(route, (m) => idFor(m, actor.home)));
        const unknown = qs(expand(route, () => UNKNOWN_ID));
        const foreignTenant = actor.foreignTenant;
        const foreign = foreignTenant
          ? qs(expand(route, (m) => (isFacilityLevel(m, tenants[actor.home]) ? idFor(m, foreignTenant) : untenanted.has(m) ? undefined : idFor(m, "other"))))
          : null;
        for (const method of route.methods) {
          // Untenanted models (a global plan, a payer) have no "other tenant's
          // id": only the unknown-id half of the rule applies.
          if (actor.foreign && unknown && !foreign) {
            for (const uUrl of unknown) {
              recordTasks.push(async () => {
                const u = await send(actor, method, uUrl);
                recordProbed.add(route.urlPath);
                const fine = u.status === 404 || u.permission || (u.status === 400 && method !== "GET") || u.status === 405;
                if (!fine) bad(`404 rule: ${method} ${route.urlPath} as ${actor.name}: unknown id → ${u.status} ${u.text.slice(0, 80)}`);
                else ok();
              });
            }
          }
          if (actor.foreign && unknown && foreign) {
            unknown.forEach((uUrl, k) => {
              recordTasks.push(async () => {
                const [u, f] = [await send(actor, method, uUrl), await send(actor, method, foreign[k])];
                recordProbed.add(route.urlPath);
                const allowed = (r: typeof u) => r.status === 404 || r.permission || (r.status === 400 && method !== "GET") || r.status === 405;
                // An identical 403 for both (e.g. the actor lacks a clinical
                // credential) is decided before the lookup and reveals nothing.
                const actorLevel = u.status === 403 && f.status === 403 && u.text === f.text;
                const problems: string[] = [];
                if (!allowed(u) && !actorLevel) problems.push(`unknown id → ${u.status} ${u.text.slice(0, 80)}`);
                if (!allowed(f) && !actorLevel) problems.push(`other tenant's id → ${f.status} ${f.text.slice(0, 80)}`);
                if (u.status !== f.status) problems.push(`unknown ${u.status} ≠ other tenant's ${f.status}`);
                if (problems.length) bad(`404 rule: ${method} ${route.urlPath} as ${actor.name}: ${problems.join("; ")} [unknown: ${u.status} ${u.text.slice(0, 80)} | other tenant's: ${f.status} ${f.text.slice(0, 80)}]`);
                else ok();
                recordStatuses[`${u.status}`] = (recordStatuses[`${u.status}`] ?? 0) + 1;
              });
            });
          }
          if (method === "GET" && own) {
            for (const oUrl of own) {
              recordTasks.push(async () => {
                const r = await send(actor, "GET", oUrl);
                if (r.ok) ownGetOk.add(route.urlPath);
                leakCheck(actor, `own-record ${oUrl}`, r);
              });
            }
          }
        }
      }
    }
    await pool(recordTasks, 16);
    console.log(`Record routes: ${recordTasks.length} requests`);

    // ── 5. organization-level rows ──
    if (owned.other.org.get(ORG_TASK_ID) === "Task") ok();
    else bad("org-level: the other organization's org-level task is not in its owned rows, so the leak checks can't see it");
    for (const actor of actors.filter((a) => a.foreign)) {
      const [u, f] = [await send(actor, "PATCH", `/api/hospital/tasks/${UNKNOWN_ID}`), await send(actor, "PATCH", `/api/hospital/tasks/${ORG_TASK_ID}`)];
      if (f.status === u.status && (f.status === 404 || f.permission)) ok();
      else bad(`org-level: PATCH tasks/<other org's org-level task> as ${actor.name} → ${f.status} (unknown id → ${u.status}) ${f.text.slice(0, 80)}`);
    }

    await idempotencySection(base, { pune: owned.pune.facility, noida: owned.noida.facility });
    await medicationLinkSection(base);
  } finally {
    child.kill("SIGTERM");
    await prisma.$disconnect();
  }

  // ── coverage ──
  const getRoutesAll = allRoutes.filter((r) => r.methods.includes("GET"));
  const staticGet = getRoutesAll.filter((r) => !r.segments.some((s, i) => s.startsWith("[") && segmentTarget(r, i).kind !== "static"));
  const recordRoutes = allRoutes.filter((r) => r.segments.some((s, i) => s.startsWith("[") && segmentTarget(r, i).kind === "record"));
  const notCovered = staticGet.filter((r) => !covered.has(r.urlPath));
  const notProbed = recordRoutes.filter((r) => !recordProbed.has(r.urlPath));
  console.log(`\nHTTP statuses seen: ${Object.entries(statuses).map(([s, n]) => `${s}×${n}`).join(" ")}`);
  if (serverErrors.size) {
    for (const e of serverErrors) bad(`server error: ${e}`);
  }
  console.log(`Static GET routes answering 2xx to at least one actor: ${staticGet.length - notCovered.length}/${staticGet.length}`);
  for (const r of notCovered) {
    const reason = ALLOWLIST[`GET ${r.urlPath}`];
    if (reason) console.log(`  allowlisted: GET ${r.urlPath} — ${reason}`);
    else bad(`coverage: GET ${r.urlPath} returned no data to any actor`);
  }
  console.log(`Record-ID routes probed by the 404 rule: ${recordRoutes.length - notProbed.length}/${recordRoutes.length} (unknown-id statuses: ${Object.entries(recordStatuses).map(([k, v]) => `${k}×${v}`).join(" ")}); own-record GETs with data: ${ownGetOk.size}`);
  for (const r of notProbed) {
    const reason = ALLOWLIST[`ROUTE ${r.urlPath}`];
    if (reason) console.log(`  allowlisted: ${r.urlPath} — ${reason}`);
    else bad(`coverage: ${r.urlPath} was never probed`);
  }
  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail) {
    console.log("\nFailures:");
    for (const f of failures.slice(0, 200)) console.log(`  - ${f}`);
    if (failures.length > 200) console.log(`  … and ${failures.length - 200} more`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
