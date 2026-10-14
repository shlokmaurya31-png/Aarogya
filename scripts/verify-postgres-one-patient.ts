/**
 * Gate 2: one patient, one record, everywhere. Over real HTTP:
 *
 *   1. The front desk registers a patient in Hospital OS.
 *   2. The same person self-registers in the patient portal: a likely match,
 *      so a code goes to the phone on the hospital record; entering it links
 *      the account to that record. No second Patient is created.
 *   3. The front desk opens an encounter; the patient uploads a document.
 *   4. The portal, the Hospital OS chart and the hospital API all return the
 *      same patient ID, the same demographics, the same encounter and the
 *      same document.
 *
 * Builds and starts the app (unless --no-build) with SMS_PROVIDER=outbox, so
 * the gate can read the code the server sent.
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-one-patient.ts [--no-build]
 */
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { prisma } from "../src/lib/db";
import { startServer, loginAs } from "./lib/appServer";

const OUTBOX = path.resolve(__dirname, "..", ".data", "outbox", "sms.jsonl");
const STAFF_PASSWORD = "Hospital@123";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

async function main() {
  const run = Date.now().toString(36);
  const phone = `98${String(Date.now()).slice(-8)}`;
  const person = { fullName: `Asha OnePatient ${run}`, sex: "F", phone, bloodGroup: "B+", ageYears: 34 };
  await rm(OUTBOX, { force: true });

  const { base, child } = await startServer({ SMS_PROVIDER: "outbox" });
  try {
    const call = async (cookie: string, method: string, url: string, body?: unknown, ip?: string) => {
      const res = await fetch(base + url, {
        method,
        headers: { cookie, ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}), ...(ip ? { "x-forwarded-for": ip } : {}) },
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, json, setCookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
    };
    const frontDesk = await loginAs(base, "frontdesk@amc-demo.aarogya", STAFF_PASSWORD);
    const doctor = await loginAs(base, "doctor1@amc-demo.aarogya", STAFF_PASSWORD);

    // 1. Front desk registration.
    const reg = await call(frontDesk, "POST", "/api/hospital/patients", person);
    const hospitalPatient = reg.json.patient as { id: string; uhid: string } | undefined;
    report("Front desk registers the patient", reg.status === 200 && Boolean(hospitalPatient?.id), `HTTP ${reg.status}`);
    if (!hospitalPatient) throw new Error("front-desk registration failed");
    const P = hospitalPatient.id;

    // 2. The same person self-registers and verifies with the code sent to the record's phone.
    const self = await call("", "POST", "/api/patient/register",
      { fullName: person.fullName, email: `one-patient-${run}@verify.aarogya`, password: "OnePatient@123", sex: "F", phone: `+91 ${phone}` }, "10.88.0.1");
    report("Self-registration finds the record and asks for the code", self.status === 200 && self.json.status === "VERIFICATION_REQUIRED", String(self.json.status));
    report("…without revealing the record's ID", !JSON.stringify(self.json).includes(P));
    const patientCookie = self.setCookie;
    const sent = (await readFile(OUTBOX, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { to: string; text: string });
    const code = sent.reverse().find((m) => m.to.replace(/\D/g, "").endsWith(phone))?.text.match(/\b(\d{6})\b/)?.[1];
    report("The code went to the phone on the hospital record", Boolean(code));
    const link = await call(patientCookie, "POST", "/api/patient/link", { code });
    report("Entering the code links the account to the front desk's record", link.status === 200 && link.json.status === "LINKED" && link.json.patientId === P, JSON.stringify(link.json));
    const sameName = await prisma.patient.count({ where: { fullName: person.fullName } });
    report("Exactly one Patient exists for this person", sameName === 1, `${sameName}`);

    // 3. Encounter and upload.
    const enc = await call(frontDesk, "POST", "/api/hospital/encounters", { patientId: P, type: "OPD", chiefComplaint: "Follow-up for one-patient gate" });
    const E = (enc.json.encounter as { id: string } | undefined)?.id;
    report("Front desk opens an encounter", enc.status === 200 && Boolean(E), `HTTP ${enc.status}`);
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 100]).drawText(`one-patient ${run}`, { x: 10, y: 50, size: 8 });
    const form = new FormData();
    form.append("file", new Blob([Buffer.from(await pdf.save())], { type: "application/pdf" }), "outside-report.pdf");
    form.append("title", "Outside report (one-patient gate)");
    form.append("type", "REPORT");
    const up = await call(patientCookie, "POST", "/api/patient/documents", form);
    const D = (up.json.document as { id: string } | undefined)?.id;
    report("The patient uploads a document", up.status === 200 && Boolean(D), `HTTP ${up.status}`);

    // 4. Same patient, demographics, encounter and document everywhere.
    const same = (p: Record<string, unknown> | undefined) =>
      Boolean(p) && p!.fullName === person.fullName && p!.sex === person.sex && p!.phone === person.phone && p!.bloodGroup === person.bloodGroup;

    const portal = await call(patientCookie, "GET", "/api/patient/me");
    const portalSummary = portal.json.summary as { patient: Record<string, unknown>; recentEncounters: { id: string }[] } | undefined;
    report("Portal: same patient ID", portalSummary?.patient.id === P, `HTTP ${portal.status}${portal.status === 200 ? "" : ` ${JSON.stringify(portal.json).slice(0, 200)}`}`);
    report("Portal: same demographics", same(portalSummary?.patient));
    report("Portal: the encounter", Boolean(portalSummary?.recentEncounters.some((e) => e.id === E)));
    const profile = await call(patientCookie, "GET", "/api/patient/profile");
    report("Portal profile: same demographics", profile.json.fullName === person.fullName && profile.json.sex === person.sex && profile.json.phone === person.phone && profile.json.bloodGroup === person.bloodGroup);
    const reports = await call(patientCookie, "GET", "/api/patient/reports");
    report("Portal: the document", ((reports.json.reports as { id: string }[]) ?? []).some((r) => r.id === `document:${D}`));

    const chart = await call(doctor, "GET", `/api/hospital/patients/${P}/chart`);
    const chartPatient = chart.json.patient as Record<string, unknown> | undefined;
    report("Hospital OS chart: same patient ID", chartPatient?.id === P, `HTTP ${chart.status}`);
    report("Hospital OS chart: same demographics", same(chartPatient));
    report("Hospital OS chart: the encounter", ((chart.json.encounters as { id: string }[]) ?? []).some((e) => e.id === E));
    const docs = await call(doctor, "GET", `/api/hospital/documents?patientId=${P}`);
    report("Hospital OS chart: the document", ((docs.json.documents as { id: string }[]) ?? []).some((d) => d.id === D));

    const api = await call(frontDesk, "GET", `/api/hospital/patients/${P}`);
    const apiPatient = api.json.patient as Record<string, unknown> | undefined;
    report("API: same patient ID and demographics", apiPatient?.id === P && same(apiPatient));
    const search = await call(frontDesk, "GET", `/api/hospital/patients?q=${encodeURIComponent(hospitalPatient.uhid)}`);
    const found = ((search.json.patients as { id: string }[]) ?? []).map((p) => p.id);
    report("API: searching the UHID finds exactly this patient", found.length === 1 && found[0] === P, found.join(","));
  } finally {
    child.kill("SIGTERM");
    await prisma.$disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
