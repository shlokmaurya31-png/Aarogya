/**
 * The D7 bookability rule (clinic session, no absence, on shift) applies to
 * scheduled appointments only. Walk-ins are never turned away for lack of a
 * session:
 *   1. A walk-in OPD encounter gets a queue token for a doctor who has no
 *      clinic session configured at all.
 *   2. An ED arrival registers and is triaged with no session configured.
 *   3. Contrast: a scheduled appointment with the same doctor is refused
 *      (NO_SESSION), so the rule is live — it just doesn't gate walk-ins.
 *   4. Statically: only the appointment paths call the bookability rule.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-walk-ins.ts
 */
import "./lib/gateBootstrap";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/db";
import { enterQueue } from "../src/lib/hospital/queue";
import { registerEdArrival } from "../src/lib/hospital/emergency";
import { recordTriage } from "../src/lib/hospital/triage";
import { bookAppointment } from "../src/lib/hospital/appointment";
import { DoctorNotBookableError } from "../src/lib/hospital/bookability";
import { ensurePrimaryMembership } from "../prisma/seedData/staffMembership";
import { gateClock } from "./lib/testClock";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
}

async function main() {
  const run = Date.now().toString(36);
  const facilityId = "fac-amc-pune";
  const frontDesk = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { user: { email: "frontdesk@amc-demo.aarogya" } } });
  const user = await prisma.user.create({ data: { email: `walkin-doc-${run}@verify.aarogya`, passwordHash: "x", role: "DOCTOR", displayName: `Dr Walk-in ${run}` } });
  const doctor = await prisma.hospitalStaffProfile.create({ data: { userId: user.id, displayRole: "Physician", status: "ACTIVE" } });
  await ensurePrimaryMembership(prisma, user.id, facilityId);
  report("The doctor has no clinic session configured", (await prisma.doctorScheduleBlock.count({ where: { staffId: doctor.id } })) === 0);
  const patient = await prisma.patient.create({ data: { uhid: `WALKIN-${run}`, facilityId, fullName: `Walk-in ${run}`, sex: "F" } });

  // 1. Walk-in OPD token.
  const encounter = await prisma.encounter.create({ data: { facilityId, patientId: patient.id, type: "OPD", accessSource: "WALK_IN" } });
  const token = await enterQueue({
    facilityId, queueType: "OPD", patientId: patient.id, encounterId: encounter.id, practitionerStaffId: doctor.id,
    createdByStaffId: frontDesk.id, byUserId: frontDesk.userId,
  }).catch((e: Error) => e);
  report("A walk-in OPD patient gets a queue token without a clinic session",
    !(token instanceof Error) && token.status === "WAITING" && token.practitionerStaffId === doctor.id, token instanceof Error ? token.message : token.status);

  // 2. ED arrival and triage.
  const ed = await registerEdArrival({ facilityId, patientId: patient.id, chiefComplaint: "Chest pain", arrivalMode: "WALK_IN", registeredByStaffId: frontDesk.id, byUserId: frontDesk.userId })
    .catch((e: Error) => e);
  report("An ED arrival registers without any clinic session", !(ed instanceof Error) && ed.type === "ED", ed instanceof Error ? ed.message : ed.status);
  if (!(ed instanceof Error)) {
    const triage = await recordTriage({ encounterId: ed.id, recordedByStaffId: doctor.id, acuity: 2, chiefComplaint: "Chest pain", byUserId: user.id })
      .then(() => "triaged", (e: Error) => e.message);
    report("…and is triaged by a doctor who has no session", triage === "triaged", triage);
  }

  // 3. Contrast: scheduled booking with the same doctor is refused.
  const start = gateClock.at(2, 10);
  const booked = await bookAppointment({
    facilityId, doctorStaffId: doctor.id, patientId: patient.id, scheduledStart: start, scheduledEnd: new Date(start.getTime() + 15 * 60_000),
    createdByStaffId: frontDesk.id, byUserId: frontDesk.userId,
  }).then(() => "booked", (e) => (e instanceof DoctorNotBookableError ? e.reason : String(e)));
  report("A scheduled appointment with the same doctor is refused (NO_SESSION)", booked === "NO_SESSION", booked);

  // 4. Only the appointment paths use the rule.
  const root = path.resolve(__dirname, "..", "src");
  const users = walk(root).filter((f) => /\b(assertBookable|evaluateBookability|loadDayContext)\(/.test(readFileSync(f, "utf8")))
    .map((f) => path.relative(root, f)).sort();
  const allowed = ["lib/hospital/appointment.ts", "lib/hospital/bookability.ts", "lib/hospital/doctorSchedule.ts"];
  report("Only scheduled-appointment code calls the bookability rule", users.every((f) => allowed.includes(f)), users.join(", "));

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
