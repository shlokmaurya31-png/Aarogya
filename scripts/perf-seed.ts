/**
 * Flagship 1c — the performance seed: one year of a 200-bed hospital at the
 * Pune demo facility (fac-amc-pune), into the local verify database only (the
 * gate bootstrap refuses any other). Synthetic, deterministic, set-based SQL:
 *
 *   40,000 patients · 60,000 encounters (45,000 OPD, 6,000 ED, 9,000 IPD;
 *   about 150 inpatients and a dozen ED patients in now) · 160 more beds (200
 *   in all) · ~300,000 orders (lab ~204,000 with results, imaging ~25,500,
 *   medication ~78,000) · ~160,000 MAR doses · ~170,000 vitals · 60,000
 *   diagnoses, ~87,000 notes · 60,000 billing accounts, ~294,000 charges ·
 *   ~45,000 appointments and queue entries · ~90,000 nursing tasks ·
 *   1,000,000 domain events (processed history) · 5,000 people with an upload
 *   each (processed, facts reviewed) · 50,000 indexed record chunks.
 *
 * And, through the real services, the people the perf gate signs in as: a
 * patient with a heavy record (about 120 visits and 600 orders, indexed for
 * the AI), 40 uploads with facts to review, a household of four, today's
 * check-ins, and 150 listed doctors in the directory.
 *
 * Runs after a reset + seed (`npm run perf:gate -- --fresh` does all three).
 * Refuses to run twice on the same database. Writes the perf fixture (ids,
 * logins) to .perf-report/fixture.json.
 *
 * Usage: DATABASE_URL=…/aarogya_verify DIRECT_URL=…/aarogya_verify npx tsx scripts/perf-seed.ts
 */
import "./lib/gateBootstrap";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth/password";
import { registerPatientAccount } from "../src/lib/patient/selfRegistration";
import { sourcesOfPatient, indexSource } from "../src/lib/rag/indexer";
import { facilityAdmin, networkDoctor, verifier } from "./lib/doctorFixture";
import { indiaDate } from "./lib/testClock";
import { SPECIALTY_CODES } from "../src/lib/doctors/vocab";

const F = "fac-amc-pune";
const OUT = path.join(__dirname, "..", ".perf-report");
export const PERF_PASSWORD = "Perf@12345";

async function q(label: string, sql: string, ...params: unknown[]) {
  const t0 = Date.now();
  const n = await prisma.$executeRawUnsafe(sql, ...params);
  console.log(`  ${label}: ${n.toLocaleString("en-IN")} rows (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  return n;
}
const arr = (xs: string[]) => `ARRAY[${xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(",")}]::text[]`;

async function main() {
  if (await prisma.patient.findUnique({ where: { id: "pf-p-2" }, select: { id: true } })) {
    console.error("The perf seed is already in this database. Reset first (npm run perf:gate -- --fresh).");
    process.exit(2);
  }
  const started = Date.now();
  const org = (await prisma.facility.findUniqueOrThrow({ where: { id: F }, select: { organizationId: true } })).organizationId!;
  const staffOf = async (role: string) => (await prisma.hospitalStaffProfile.findMany({ where: { user: { role: role as never, email: { endsWith: "@amc-demo.aarogya" } } }, orderBy: { id: "asc" }, select: { id: true } })).map((s) => s.id);
  const doctors = await staffOf("DOCTOR");
  const nurses = await staffOf("NURSE");
  const depts = (await prisma.department.findMany({ where: { facilityId: F }, orderBy: { id: "asc" }, select: { id: true } })).map((d) => d.id);
  const wards = (await prisma.ward.findMany({ where: { facilityId: F, wardType: { not: "EMERGENCY" } }, orderBy: { id: "asc" }, select: { id: true } })).map((w) => w.id);
  const billingUser = (await prisma.user.findFirstOrThrow({ where: { email: "billing@amc-demo.aarogya" }, select: { id: true } })).id;
  if (doctors.length < 4 || nurses.length < 4) throw new Error("The demo seed's Pune staff are missing: run the seed first.");
  const D = arr(doctors), N = arr(nurses), DEP = arr(depts), W = arr(wards);
  // Element `k` (0-based, cycled) of an array literal.
  const pick = (a: string, k: string) => `(${a})[1 + ((${k}) % cardinality(${a}))]`;

  // The perf patient: a real registration (Person, account, link), whose record gets the heavy history.
  const email = `perf-patient@verify.aarogya`;
  const reg = await registerPatientAccount({ facilityId: F, fullName: "Perf Heavy Patient", email, passwordHash: await hashPassword(PERF_PASSWORD), sex: "F", dob: new Date("1961-05-05"), phone: "+919800000001" });
  if (reg.status !== "LINKED_NEW") throw new Error(`perf patient registration: ${reg.status}`);
  const heavyLink = await prisma.personPatientLink.findFirstOrThrow({ where: { person: { accounts: { some: { userId: reg.userId } } }, status: "ACTIVE" } });
  const HEAVY = heavyLink.patientId, HEAVY_PERSON = heavyLink.personId;
  console.log("Perf seed into the verify database (one year, a 200-bed hospital):");

  // ── People and visits ────────────────────────────────────────────────
  await q("patients", `
    INSERT INTO "Patient" ("id","uhid","facilityId","fullName","sex","dob","phone","createdAt","updatedAt","dobPrecision")
    SELECT 'pf-p-' || i, 'PF' || lpad(i::text, 6, '0'), '${F}',
      (ARRAY['Aarav','Diya','Vihaan','Ananya','Reyansh','Saanvi','Arjun','Ishita','Kabir','Meera','Rohan','Priya','Aditya','Kavya','Siddharth','Nisha'])[1 + i % 16] || ' ' ||
      (ARRAY['Sharma','Patil','Iyer','Reddy','Das','Khan','Joshi','Nair','Gupta','Kulkarni','Singh','Banerjee','Mehta','Rao'])[1 + (i / 16) % 14],
      CASE WHEN i % 2 = 0 THEN 'F' ELSE 'M' END, DATE '1940-01-01' + (i * 37 % 29000), '+9190' || lpad(i::text, 8, '0'),
      now() - interval '400 days' + (i || ' minutes')::interval, now(), 'DAY'
    FROM generate_series(2, 40000) i`);
  // Encounter i (1..60000) registers at a point through the year, in order; 15% IPD, 10% ED, 75% OPD.
  // Every 499th (a mix of OPD, ED and IPD) belongs to the perf patient. The last ones are today: inpatients in beds, ED patients, the OPD clinic.
  await q("encounters", `
    INSERT INTO "Encounter" ("id","patientId","facilityId","departmentId","type","status","chiefComplaint","attendingStaffId","registeredAt","closedAt","accessSource")
    SELECT 'pf-e-' || i, CASE WHEN i % 499 = 0 THEN $1 ELSE 'pf-p-' || (2 + (i * 7919) % 39999) END, '${F}', ${pick(DEP, "i")},
      t.type::"EncounterType", t.status::"EncounterStatus",
      (ARRAY['Fever for three days','Chest pain','Knee pain','Follow-up of diabetes','Cough and breathlessness','Abdominal pain','Headache','Routine antenatal visit','Back pain','Hypertension review'])[1 + i % 10],
      ${pick(D, "i")}, t.at, CASE WHEN t.status IN ('CLOSED','DISCHARGED') THEN t.at + t.len ELSE NULL END,
      (CASE t.type WHEN 'ED' THEN 'EMERGENCY' WHEN 'IPD' THEN 'REFERRAL' ELSE 'APPOINTMENT' END)::"AccessSource"
    FROM generate_series(1, 60000) i,
    LATERAL (SELECT CASE WHEN i % 20 < 3 THEN 'IPD' WHEN i % 20 < 5 THEN 'ED' ELSE 'OPD' END AS type,
                    now() - interval '365 days' + (i * interval '8.76 minutes') AS at) b,
    LATERAL (SELECT b.type, b.at,
      CASE WHEN b.type = 'IPD' THEN interval '6 days' WHEN b.type = 'ED' THEN interval '5 hours' ELSE interval '40 minutes' END AS len,
      CASE WHEN b.type = 'IPD' AND b.at > now() - interval '6 days' THEN 'ADMITTED'
           WHEN b.type = 'ED' AND b.at > now() - interval '30 hours' THEN 'TRIAGED'
           WHEN b.type = 'OPD' AND b.at > now() - interval '8 hours' THEN (ARRAY['REGISTERED','TRIAGED','IN_CONSULTATION'])[1 + i % 3]
           ELSE 'CLOSED' END AS status) t`, HEAVY);
  await q("beds (to 200)", `
    INSERT INTO "Bed" ("id","label","wardId","facilityId","status","createdAt","updatedAt")
    SELECT 'pf-bed-' || k, 'PF-' || lpad(k::text, 3, '0'), ${pick(W, "k")}, '${F}', 'AVAILABLE', now() - interval '400 days', now()
    FROM generate_series(1, 160) k`);
  // IPD encounter j-th (in order) takes perf bed j % 160; the ones admitted now are the last ~150, on distinct beds.
  await q("admissions", `
    INSERT INTO "Admission" ("id","encounterId","bedId","reason","expectedLosDays","admittingStaffId","admittedAt")
    SELECT 'pf-adm-' || e.n, e."id", 'pf-bed-' || (1 + e.r % 160), 'Admitted for ' || lower(e."chiefComplaint"), 6, e."attendingStaffId", e."registeredAt"
    FROM (SELECT x.*, substring(x."id" from 6)::int AS n, row_number() OVER (ORDER BY substring(x."id" from 6)::int) AS r FROM "Encounter" x WHERE x."id" LIKE 'pf-e-%' AND x."type" = 'IPD') e`);
  await q("occupied beds", `UPDATE "Bed" b SET "status" = 'OCCUPIED' FROM "Admission" a JOIN "Encounter" e ON e."id" = a."encounterId" WHERE a."bedId" = b."id" AND e."status" = 'ADMITTED' AND b."id" LIKE 'pf-bed-%'`);
  await q("appointments", `
    INSERT INTO "Appointment" ("id","facilityId","departmentId","doctorStaffId","patientId","type","status","scheduledStart","scheduledEnd","encounterId","createdByStaffId","createdAt","updatedAt","reason")
    SELECT 'pf-ap-' || substring(e."id" from 6), '${F}', e."departmentId", e."attendingStaffId", e."patientId", 'FOLLOW_UP',
      (CASE WHEN e."status" = 'CLOSED' THEN 'COMPLETED' WHEN e."status" = 'IN_CONSULTATION' THEN 'IN_CONSULTATION' ELSE 'CHECKED_IN' END)::"AppointmentStatus",
      e."registeredAt", e."registeredAt" + interval '15 minutes', e."id", e."attendingStaffId", e."registeredAt" - interval '3 days', now(), e."chiefComplaint"
    FROM "Encounter" e WHERE e."id" LIKE 'pf-e-%' AND e."type" = 'OPD'`);
  await q("upcoming appointments (14 days)", `
    INSERT INTO "Appointment" ("id","facilityId","departmentId","doctorStaffId","patientId","type","status","scheduledStart","scheduledEnd","createdByStaffId","createdAt","updatedAt","reason")
    SELECT 'pf-apf-' || i, '${F}', ${pick(DEP, "i")}, ${pick(D, "i")}, 'pf-p-' || (2 + (i * 104729) % 39999), 'FOLLOW_UP', 'CONFIRMED',
      date_trunc('day', now()) + ((1 + i % 14) || ' days')::interval + interval '3 hours 30 minutes' + ((i / 14 % 16) * interval '15 minutes'),
      date_trunc('day', now()) + ((1 + i % 14) || ' days')::interval + interval '3 hours 45 minutes' + ((i / 14 % 16) * interval '15 minutes'),
      ${pick(D, "i")}, now(), now(), 'Review'
    FROM generate_series(1, 2000) i`);
  await q("queue entries", `
    INSERT INTO "QueueEntry" ("id","facilityId","departmentId","queueType","patientId","encounterId","appointmentId","practitionerStaffId","status","enteredAt","calledAt","completedAt")
    SELECT 'pf-q-' || substring(a."id" from 7), '${F}', a."departmentId", 'OPD_DOCTOR', a."patientId", a."encounterId", a."id", a."doctorStaffId",
      (CASE a."status" WHEN 'COMPLETED' THEN 'COMPLETED' WHEN 'IN_CONSULTATION' THEN 'IN_SERVICE' ELSE 'WAITING' END)::"QueueEntryStatus",
      a."scheduledStart", CASE WHEN a."status" <> 'CHECKED_IN' THEN a."scheduledStart" + interval '10 minutes' END, CASE WHEN a."status" = 'COMPLETED' THEN a."scheduledEnd" END
    FROM "Appointment" a WHERE a."id" LIKE 'pf-ap-%'`);

  // ── Orders, results, MAR, vitals, notes ───────────────────────────────
  const perType = (ipd: number, ed: number, opd: string) => `CASE e."type" WHEN 'IPD' THEN ${ipd} WHEN 'ED' THEN ${ed} ELSE ${opd} END`;
  await q("lab orders", `
    INSERT INTO "LabOrder" ("id","encounterId","patientId","testName","category","priority","orderedByStaffId","status","orderedAt")
    SELECT 'pf-lo-' || substring(e."id" from 6) || '-' || k, e."id", e."patientId",
      (ARRAY['Hemoglobin','Creatinine','Sodium','Potassium','Fasting glucose','HbA1c','TSH','ALT','Platelet count','Urea','CRP','Lipid profile'])[1 + (k * 5 + length(e."id")) % 12],
      (ARRAY['Hematology','Biochemistry','Biochemistry','Biochemistry','Biochemistry','Biochemistry','Endocrinology','Biochemistry','Hematology','Biochemistry','Immunology','Biochemistry'])[1 + (k * 5 + length(e."id")) % 12],
      'ROUTINE', e."attendingStaffId", (CASE WHEN e."status" IN ('CLOSED','DISCHARGED') OR k < 3 THEN 'RESULTED' ELSE 'ORDERED' END)::"LabOrderStatus", e."registeredAt" + (k * interval '7 hours')
    FROM "Encounter" e, generate_series(1, ${perType(10, 4, "2")}) k WHERE e."id" LIKE 'pf-e-%'`);
  await q("lab results", `
    INSERT INTO "LabResult" ("id","labOrderId","value","unit","referenceRange","resultedAt","resultType","numericValue","abnormalFlag","status","verifiedAt","isCurrent","releasedByStaffId","verifiedByStaffId")
    SELECT 'pf-lr-' || substring(o."id" from 7), o."id", v.val::text, 'mg/dL', '0 - 100', o."orderedAt" + interval '3 hours', 'NUMERIC', v.val,
      (CASE WHEN v.val > 95 THEN 'HIGH' WHEN v.val < 8 THEN 'LOW' ELSE 'NORMAL' END)::"AbnormalFlag", 'VERIFIED', o."orderedAt" + interval '3 hours', true, o."orderedByStaffId", o."orderedByStaffId"
    FROM "LabOrder" o, LATERAL (SELECT (abs(hashtext(o."id")) % 1000) / 10.0 AS val) v WHERE o."id" LIKE 'pf-lo-%' AND o."status" = 'RESULTED'`);
  await q("imaging orders", `
    INSERT INTO "ImagingOrder" ("id","encounterId","patientId","modality","studyDescription","priority","orderedByStaffId","status","orderedAt")
    SELECT 'pf-io-' || substring(e."id" from 6), e."id", e."patientId", (ARRAY['XRAY','CT','USG','MRI'])[1 + length(e."id") % 4], 'Study for ' || lower(e."chiefComplaint"), 'ROUTINE', e."attendingStaffId",
      (CASE WHEN e."status" IN ('CLOSED','DISCHARGED') THEN 'REPORTED' ELSE 'ORDERED' END)::"ImagingOrderStatus", e."registeredAt" + interval '1 hour'
    FROM "Encounter" e WHERE e."id" LIKE 'pf-e-%' AND (e."type" = 'ED' OR (e."type" = 'IPD' AND substring(e."id" from 6)::int % 2 = 0) OR (e."type" = 'OPD' AND substring(e."id" from 6)::int % 3 = 0))`);
  await q("medication orders", `
    INSERT INTO "MedicationOrder" ("id","encounterId","patientId","drugName","genericName","dose","route","frequency","durationDays","orderedByStaffId","status","orderedAt","startAt")
    SELECT 'pf-mo-' || substring(e."id" from 6) || '-' || k, e."id", e."patientId", m.drug, m.drug, m.dose, m.route, m.freq, 5, e."attendingStaffId",
      (CASE WHEN e."status" = 'ADMITTED' THEN 'ACTIVE' WHEN e."status" IN ('CLOSED','DISCHARGED') THEN 'COMPLETED' ELSE 'VERIFIED' END)::"MedicationOrderStatus", e."registeredAt" + interval '30 minutes', e."registeredAt" + interval '1 hour'
    FROM "Encounter" e, generate_series(1, ${perType(3, 1, "1")}) k,
    LATERAL (SELECT (ARRAY['Paracetamol','Amoxicillin','Metformin','Amlodipine','Pantoprazole','Ceftriaxone','Atorvastatin','Ondansetron'])[1 + (k + length(e."id")) % 8] AS drug,
                    (ARRAY['500 mg','250 mg','500 mg','5 mg','40 mg','1 g','10 mg','4 mg'])[1 + (k + length(e."id")) % 8] AS dose,
                    (ARRAY['PO','PO','PO','PO','IV','IV','PO','IV'])[1 + (k + length(e."id")) % 8] AS route, 'BD' AS freq) m
    WHERE e."id" LIKE 'pf-e-%'`);
  // Inpatient doses: twice a day for four days from the order's start; given until two hours ago, due since (the round in progress) and ahead.
  const given = `o."startAt" + d * interval '12 hours' < now() - interval '2 hours'`;
  await q("MAR doses", `
    INSERT INTO "MedicationAdministration" ("id","medicationOrderId","administeredByStaffId","scheduledAt","administeredAt","status")
    SELECT 'pf-ma-' || substring(o."id" from 7) || '-' || d, o."id", CASE WHEN ${given} THEN ${pick(N, "d")} END, o."startAt" + d * interval '12 hours',
      CASE WHEN ${given} THEN o."startAt" + d * interval '12 hours' + interval '10 minutes' END,
      (CASE WHEN ${given} THEN 'GIVEN' ELSE 'DUE' END)::"MedicationAdministrationStatus"
    FROM "MedicationOrder" o JOIN "Encounter" e ON e."id" = o."encounterId", generate_series(0, 7) d
    WHERE o."id" LIKE 'pf-mo-%' AND e."type" = 'IPD'`);
  await q("nursing assignments (inpatients now)", `
    INSERT INTO "NursingAssignment" ("id","facilityId","departmentId","nurseStaffId","patientId","encounterId","bedId","startAt","reason","assignedByStaffId")
    SELECT 'pf-na-' || substring(x."id" from 6), '${F}', x."departmentId", ${pick(N, "row_number() OVER (ORDER BY x.\"id\")")}, x."patientId", x."id", x."bedId", date_trunc('day', now()), 'Shift allocation', ${pick(N, "0")}
    FROM (SELECT DISTINCT ON (e."patientId") e.*, a."bedId" FROM "Encounter" e JOIN "Admission" a ON a."encounterId" = e."id"
          WHERE e."id" LIKE 'pf-e-%' AND e."status" = 'ADMITTED' ORDER BY e."patientId", e."registeredAt" DESC) x`);
  await q("vitals", `
    INSERT INTO "Vital" ("id","encounterId","recordedByStaffId","hr","sbp","dbp","rr","spo2","tempC","recordedAt")
    SELECT 'pf-v-' || substring(e."id" from 6) || '-' || k, e."id", ${pick(N, "k")}, 60 + (k * 7 + length(e."id")) % 40, 100 + (k * 11) % 50, 60 + (k * 5) % 30, 14 + k % 6, 94 + k % 6, 36.5 + (k % 10) / 10.0,
      e."registeredAt" + k * interval '8 hours'
    FROM "Encounter" e, generate_series(1, ${perType(12, 3, "1")}) k WHERE e."id" LIKE 'pf-e-%'`);
  await q("diagnoses", `
    INSERT INTO "Diagnosis" ("id","patientId","encounterId","diagnosis","type","codeSystem","code","diagnosedByStaffId","createdAt")
    SELECT 'pf-dx-' || substring(e."id" from 6), e."patientId", e."id", d.name, 'FINAL', 'ICD-10', d.code, e."attendingStaffId", e."registeredAt" + interval '30 minutes'
    FROM "Encounter" e, LATERAL (SELECT (ARRAY['Viral fever','Type 2 diabetes mellitus','Essential hypertension','Osteoarthritis of knee','Community-acquired pneumonia','Acute gastritis','Migraine','Normal pregnancy','Low back pain','Urinary tract infection'])[1 + length(e."chiefComplaint") % 10] AS name,
                                    (ARRAY['B34.9','E11.9','I10','M17.9','J18.9','K29.1','G43.9','Z34.9','M54.5','N39.0'])[1 + length(e."chiefComplaint") % 10] AS code) d
    WHERE e."id" LIKE 'pf-e-%'`);
  await q("clinical notes", `
    INSERT INTO "ClinicalNote" ("id","encounterId","authorStaffId","type","content","status","createdAt","signedAt")
    SELECT 'pf-cn-' || substring(e."id" from 6) || '-' || k, e."id", e."attendingStaffId", 'SOAP',
      jsonb_build_object('subjective', e."chiefComplaint", 'assessment', 'Stable; plan reviewed with the patient.', 'plan', 'Continue current medicines; review in one week.'),
      'SIGNED', e."registeredAt" + k * interval '1 day', e."registeredAt" + k * interval '1 day' + interval '20 minutes'
    FROM "Encounter" e, generate_series(0, ${perType(3, 0, "0")}) k WHERE e."id" LIKE 'pf-e-%'`);
  await q("nursing tasks", `
    INSERT INTO "Task" ("id","facilityId","departmentId","title","type","priority","status","dueAt","patientId","encounterId","ownerStaffId","completedByStaffId","completedAt","createdAt","source","updatedAt")
    SELECT 'pf-t-' || substring(e."id" from 6) || '-' || k, '${F}', e."departmentId", (ARRAY['Record vitals','Wound dressing','Fall-risk check','Intake and output','Turn patient','Glucose check'])[1 + k % 6], 'NURSING', 'ROUTINE',
      (CASE WHEN e."registeredAt" + k * interval '9 hours' < now() THEN 'COMPLETED' ELSE 'OPEN' END)::"TaskStatus", e."registeredAt" + k * interval '9 hours', e."patientId", e."id", ${pick(N, "k")},
      CASE WHEN e."registeredAt" + k * interval '9 hours' < now() THEN ${pick(N, "k")} END, CASE WHEN e."registeredAt" + k * interval '9 hours' < now() THEN e."registeredAt" + k * interval '9 hours' + interval '15 minutes' END,
      e."registeredAt", 'CARE_PLAN', now()
    FROM "Encounter" e, generate_series(1, 10) k WHERE e."id" LIKE 'pf-e-%' AND e."type" = 'IPD'`);

  // ── Billing ──────────────────────────────────────────────────────────
  await q("billing accounts", `
    INSERT INTO "BillingAccount" ("id","encounterId","patientId","facilityId","status","openedAt","closedAt")
    SELECT 'pf-ba-' || substring(e."id" from 6), e."id", e."patientId", '${F}', (CASE WHEN e."closedAt" IS NULL THEN 'OPEN' ELSE 'CLOSED' END)::"BillingAccountStatus", e."registeredAt", e."closedAt"
    FROM "Encounter" e WHERE e."id" LIKE 'pf-e-%'`);
  await q("charges", `
    INSERT INTO "Charge" ("id","encounterId","patientId","facilityId","description","category","sourceType","createdAt","chargeCode","currency","netAmountMinor","postedByUserId","quantity","status","unitPriceMinor","pricingStatus")
    SELECT 'pf-ch-' || substring(e."id" from 6) || '-' || k, e."id", e."patientId", '${F}', c.descr, c.cat, 'PERF_SEED', e."registeredAt" + k * interval '4 hours', c.code, 'INR', c.price, '${billingUser}', 1, 'POSTED', c.price, 'PRICED'
    FROM "Encounter" e, generate_series(1, ${perType(20, 4, "2")}) k,
    LATERAL (SELECT (ARRAY['Consultation','Bed charge (per day)','Laboratory test','Imaging study','Medicines','Nursing care'])[1 + k % 6] AS descr,
                    (ARRAY['CONSULTATION','BED','LAB','IMAGING','PHARMACY','NURSING'])[1 + k % 6] AS cat,
                    (ARRAY['CONSULT:OPD','BED:GENERAL','LAB:GENERIC','IMG:GENERIC','PHARM:GENERIC','NURS:DAY'])[1 + k % 6] AS code,
                    (ARRAY[50000, 250000, 45000, 150000, 32000, 80000])[1 + k % 6] AS price) c
    WHERE e."id" LIKE 'pf-e-%'`);

  // ── A year of events (processed history) ─────────────────────────────
  await q("domain events", `
    INSERT INTO "DomainEventOutbox" ("id","eventId","eventType","eventVersion","aggregateType","aggregateId","organizationId","facilityId","correlationId","payload","occurredAt","recordedAt","status","attemptCount","processedAt","createdAt","updatedAt")
    SELECT 'pf-ev-' || i, md5('pf-ev-' || i)::uuid::text, t.typ, 1, t.agg, 'pf-e-' || (1 + i % 60000), '${org}', '${F}', md5('pf-cor-' || (i / 5))::uuid::text,
      jsonb_build_object('encounterId', 'pf-e-' || (1 + i % 60000)), now() - interval '365 days' + (i * interval '31.536 seconds'), now() - interval '365 days' + (i * interval '31.536 seconds'),
      'PROCESSED', 1, now() - interval '365 days' + (i * interval '31.536 seconds') + interval '2 seconds', now() - interval '365 days' + (i * interval '31.536 seconds'), now()
    FROM generate_series(1, 1000000) i,
    LATERAL (SELECT (ARRAY['EncounterOpened','LabOrderPlaced','LabResultReleased','MedicationOrdered','MedicationAdministered','VitalsRecorded','ChargePosted','TaskCompleted','EncounterClosed','ImagingOrderPlaced'])[1 + i % 10] AS typ,
                    (ARRAY['Encounter','LabOrder','LabResult','MedicationOrder','MedicationAdministration','Encounter','Charge','Task','Encounter','ImagingOrder'])[1 + i % 10] AS agg) t`);

  // ── People's uploads (5,000, processed and reviewed) ─────────────────
  await q("people", `
    INSERT INTO "Person" ("id","status","displayName","dateOfBirth","sex","preferredLanguage","createdAt","updatedAt","dataClassification")
    SELECT 'pf-per-' || i, 'ACTIVE', p."fullName", p."dob", p."sex", (ARRAY['en','hi','mr','ta','bn'])[1 + i % 5], now() - interval '200 days', now(), 'SYNTHETIC'
    FROM generate_series(2, 5001) i JOIN "Patient" p ON p."id" = 'pf-p-' || i`);
  await q("record links", `
    INSERT INTO "PersonPatientLink" ("id","personId","patientId","facilityId","status","method","linkedAt","linkedByUserId","createdAt","updatedAt")
    SELECT 'pf-ppl-' || i, 'pf-per-' || i, 'pf-p-' || i, '${F}', 'ACTIVE', 'OTP_RECORD_CONTACT', now() - interval '200 days', '${reg.userId}', now() - interval '200 days', now()
    FROM generate_series(2, 5001) i`);
  const uploads = (key: string, person: string, from: number, to: number, perPerson: string) => `
    INSERT INTO "PersonDocument" ("id","personId","type","title","storageRef","sha256","contentType","status","uploadedByUserId","uploadedAt","createdAt","updatedAt")
    SELECT '${key}-' || i || '-' || k, ${person}, (ARRAY['LAB_REPORT','PRESCRIPTION','DISCHARGE_SUMMARY','IMAGING_REPORT'])[1 + (i + k) % 4], (ARRAY['Blood test report','Prescription','Discharge summary','X-ray report'])[1 + (i + k) % 4] || ' ' || k,
      'perf/' || md5('${key}' || i || '-' || k), md5('${key}' || i || '-' || k) || md5('${key}' || k), 'application/pdf', 'CURRENT', '${reg.userId}', now() - ((i + k * 7) % 365 || ' days')::interval, now(), now()
    FROM generate_series(${from}, ${to}) i, generate_series(1, ${perPerson}) k`;
  await q("uploads", uploads("pf-doc", `'pf-per-' || i`, 2, 5001, "1"));
  await q("uploads (perf patient)", uploads("pf-mydoc", `'${HEAVY_PERSON}'`, 1, 1, "40"));
  await q("document processing", `
    INSERT INTO "DocumentProcessing" ("id","personId","documentId","run","status","targetLanguage","pageCount","startedAt","completedAt","createdAt","updatedAt")
    SELECT 'pf-dp-' || substring(d."id" from 4), d."personId", d."id", 1, (CASE WHEN d."id" LIKE 'pf-mydoc-%' THEN 'AWAITING_REVIEW' ELSE 'COMPLETED' END)::"DocumentProcessingStatus", 'en', 2, d."uploadedAt", CASE WHEN d."id" LIKE 'pf-mydoc-%' THEN NULL ELSE d."uploadedAt" + interval '2 minutes' END, d."uploadedAt", now()
    FROM "PersonDocument" d WHERE d."id" LIKE 'pf-doc-%' OR d."id" LIKE 'pf-mydoc-%'`);
  await q("extracted facts", `
    INSERT INTO "ExtractedFact" ("id","processingId","personId","factType","value","confidence","confidenceBand","pageNo","sourceText","exactCopyCheck","reviewStatus","reviewedByUserId","reviewedAt","reviewedVia","createdAt")
    SELECT p."id" || '-f' || k, p."id", p."personId", (ARRAY['LAB_VALUE','LAB_VALUE','DIAGNOSIS','MEDICATION','LAB_VALUE','ALLERGY','PROCEDURE','DOCUMENT_META'])[1 + k % 8]::"ExtractedFactType",
      jsonb_build_object('name', (ARRAY['Hemoglobin','Creatinine','Type 2 diabetes','Metformin 500 mg','HbA1c','Penicillin','Appendectomy','Report date'])[1 + k % 8], 'value', (k * 13 % 100)::text),
      0.9, 'HIGH', 1 + k % 2, (ARRAY['Hemoglobin','Creatinine','Type 2 diabetes','Metformin 500 mg','HbA1c','Penicillin','Appendectomy','Report date'])[1 + k % 8], 'PASSED',
      (CASE WHEN p."status" = 'AWAITING_REVIEW' THEN 'PENDING' ELSE 'CONFIRMED' END)::"FactReviewStatus",
      CASE WHEN p."status" = 'AWAITING_REVIEW' THEN NULL ELSE '${reg.userId}' END, CASE WHEN p."status" = 'AWAITING_REVIEW' THEN NULL ELSE p."createdAt" + interval '1 day' END,
      (CASE WHEN p."status" = 'AWAITING_REVIEW' THEN NULL ELSE 'SELF' END)::"ReviewedVia", p."createdAt"
    FROM "DocumentProcessing" p, generate_series(0, 7) k WHERE p."id" LIKE 'pf-dp-%'`);

  // ── The perf patient's household (four members) ──────────────────────
  await q("household", `INSERT INTO "Household" ("id","name","createdByPersonId","status") VALUES ('pf-hh-1', 'Perf family', $1, 'ACTIVE')`, HEAVY_PERSON);
  await q("household members", `
    INSERT INTO "HouseholdMember" ("id","householdId","personId","memberType","role","status")
    VALUES ('pf-hm-1', 'pf-hh-1', $1, 'SELF', 'MANAGER', 'ACTIVE'), ('pf-hm-2', 'pf-hh-1', 'pf-per-2', 'LINKED_ADULT', 'MEMBER', 'ACTIVE'),
           ('pf-hm-3', 'pf-hh-1', 'pf-per-3', 'LINKED_ADULT', 'MEMBER', 'ACTIVE'), ('pf-hm-4', 'pf-hh-1', 'pf-per-4', 'LINKED_ADULT', 'MEMBER', 'ACTIVE')`, HEAVY_PERSON);

  await q("the perf patient's next visit", `
    INSERT INTO "Appointment" ("id","facilityId","departmentId","doctorStaffId","patientId","type","status","scheduledStart","scheduledEnd","createdByStaffId","createdAt","updatedAt","reason")
    VALUES ('pf-ap-heavy-next', '${F}', ${pick(DEP, "0")}, ${pick(D, "0")}, $1, 'FOLLOW_UP', 'CONFIRMED', date_trunc('day', now()) + interval '3 days 4 hours', date_trunc('day', now()) + interval '3 days 4 hours 15 minutes', ${pick(D, "0")}, now(), now(), 'Diabetes review')`, HEAVY);

  // ── Today's pre-arrival check-ins (60 visits later today, India day) ──
  const today = indiaDate(new Date());
  await q("today's visits with a check-in", `
    INSERT INTO "Appointment" ("id","facilityId","departmentId","doctorStaffId","patientId","type","status","scheduledStart","scheduledEnd","createdByStaffId","createdAt","updatedAt","reason")
    SELECT 'pf-apc-' || i, '${F}', ${pick(DEP, "i")}, ${pick(D, "i")}, 'pf-p-' || (1 + i), 'FOLLOW_UP', 'CONFIRMED', now() + (i * interval '2 minutes'), now() + (i * interval '2 minutes') + interval '15 minutes', ${pick(D, "i")}, now(), now(), 'Review'
    FROM generate_series(1, 60) i`);
  await q("today's check-ins", `
    INSERT INTO "PreArrivalCheckIn" ("id","facilityId","kind","appointmentId","patientId","personId","eligibility","token","tokenDay","submittedByPersonId","status")
    SELECT 'pf-ci-' || i, '${F}', 'APPOINTMENT', 'pf-apc-' || i, 'pf-p-' || (1 + i), 'pf-per-' || (1 + i), 'SELF_PAY', 'P-' || lpad(i::text, 3, '0'), '${today}', 'pf-per-' || (1 + i), 'SUBMITTED'
    FROM generate_series(1, 60) i`);

  // ── Record chunks for the AI (50,000 across 1,000 patients) ──────────
  await q("chunk base vectors", `CREATE UNLOGGED TABLE perf_base AS SELECT k, ('[' || array_to_string(ARRAY(SELECT (random() * 2 - 1)::real FROM generate_series(1, 1024) j WHERE j > k * 0), ',') || ']')::halfvec AS v FROM generate_series(0, 255) k`);
  await q("record documents", `
    INSERT INTO "RagDocument" ("id","ownerType","organizationId","facilityId","patientId","sourceType","sourceId","sourceVersion","origin","contentHash","categories","audience","title","recordedAt","embeddingModel","embeddingDim")
    SELECT 'pf-rd-' || p || '-' || d, 'FACILITY_PATIENT', '${org}', '${F}', 'pf-p-' || p, 'CLINICAL_NOTE', 'pf-rs-' || p || '-' || d, 1, 'VERIFIED', md5(p || '-' || d), ARRAY['CLINICAL_NOTES','LABS']::"RagCategory"[], 'PATIENT_VISIBLE', 'Progress note ' || d, now() - (d || ' days')::interval, 'mock-hash-1024', 1024
    FROM generate_series(2, 1001) p, generate_series(1, 10) d`);
  await q("record chunks", `
    INSERT INTO "RagChunk" ("id","documentId","chunkNo","ownerType","facilityId","patientId","categories","origin","audience","sourceType","sourceId","recordedAt","context","text","tokenCount")
    SELECT 'pf-rc-' || p || '-' || d || '-' || k, 'pf-rd-' || p || '-' || d, k, 'FACILITY_PATIENT', '${F}', 'pf-p-' || p, ARRAY['CLINICAL_NOTES','LABS']::"RagCategory"[], 'VERIFIED', 'PATIENT_VISIBLE', 'CLINICAL_NOTE', 'pf-rs-' || p || '-' || d, now() - (d || ' days')::interval,
      '[Progress note · verified]', (ARRAY['Hemoglobin','Creatinine','Sodium','Glucose','TSH'])[1 + (d + k) % 5] || ' ' || ((p + d * 7 + k) % 200) || ' recorded; plan to review.', 30
    FROM generate_series(2, 1001) p, generate_series(1, 10) d, generate_series(0, 4) k`);
  await q("record embeddings", `
    INSERT INTO "RagEmbedding" ("id","chunkId","embeddingModel","embeddingVersion","dims","embedding","ownerType","facilityId","patientId")
    SELECT 'e-' || c."id", c."id", 'mock-hash-1024', 1, 1024, b.v, 'FACILITY_PATIENT', c."facilityId", c."patientId"
    FROM "RagChunk" c JOIN perf_base b ON b.k = abs(hashtext(c."id")) % 256 WHERE c."id" LIKE 'pf-rc-%'`);
  await q("drop base vectors", `DROP TABLE perf_base`);

  // ── Through the services: the heavy record indexed, the directory ────
  const t1 = Date.now();
  const sources = await sourcesOfPatient(HEAVY);
  for (const s of sources) await indexSource(s);
  console.log(`  the perf patient's record indexed for the AI: ${sources.length} sources (${((Date.now() - t1) / 1000).toFixed(1)} s)`);
  const t2 = Date.now();
  const v = await verifier();
  const admin = await facilityAdmin(F);
  const specialties = SPECIALTY_CODES;
  for (let i = 0; i < 150; i++) {
    await networkDoctor(F, v, admin, { name: `Dr Perf ${i}`, specialties: [specialties[i % specialties.length]], point: { lat: 18.4 + (i % 30) / 100, lng: 73.7 + (i % 25) / 100 } });
  }
  console.log(`  listed doctors: 150 (${((Date.now() - t2) / 1000).toFixed(1)} s)`);

  await q("analyze", `ANALYZE`);
  const heavyIpd = await prisma.encounter.findFirstOrThrow({ where: { patientId: HEAVY, type: "IPD" }, orderBy: { registeredAt: "desc" }, select: { id: true } });
  const reviewDoc = await prisma.personDocument.findFirstOrThrow({ where: { personId: HEAVY_PERSON, id: { startsWith: "pf-mydoc-" } }, orderBy: { id: "asc" }, select: { id: true } });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, "fixture.json"), JSON.stringify({ facilityId: F, heavyPatientId: HEAVY, heavyPersonId: HEAVY_PERSON, heavyIpdEncounterId: heavyIpd.id, reviewDocumentId: reviewDoc.id, patientEmail: email, patientPassword: PERF_PASSWORD, seededAt: new Date().toISOString() }, null, 2));
  console.log(`Perf seed done in ${Math.round((Date.now() - started) / 1000)} s.`);
}

main().then(() => prisma.$disconnect(), async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
