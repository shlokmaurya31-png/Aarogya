/**
 * Flagship 2a (pre-launch item 25): a facility's day is its own, whatever zone
 * the server runs in. Every facility has an IANA time zone (default
 * Asia/Kolkata); clinic sessions, "today", check-in days and summaries are
 * computed in it (src/lib/time/zone.ts).
 *
 * The same questions are asked of the services (scripts/lib/tzProbe.ts, a
 * child process) and of the running app (next start), each under
 * TZ=Asia/Kolkata, TZ=UTC and TZ=America/Los_Angeles, and every answer must be
 * the India-time answer:
 *   1. a doctor's slots on a day (named by a date, or by a moment in it) are
 *      09:00–12:45 India time, from the hospital route and the directory;
 *   2. booking 09:15 India time succeeds; 14:30 India time (09:00 in UTC,
 *      the bug item 25 describes) is refused as outside the session;
 *   3. the appointments list for a day, the check-in desk's day, the command
 *      centre's "today", the person's summary day and the next-slot
 *      projection agree;
 *   4. leave and a one-off session entered for a date land on that India
 *      date and hours.
 *
 * Usage: through `npm run verify:all` (builds the app itself; --no-build reuses one).
 */
import "./lib/gateBootstrap";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { prisma } from "../src/lib/db";
import { startServer, loginAs } from "./lib/appServer";
import { doctorLogin, facilityAdmin, networkDoctor, sessions, verifier } from "./lib/doctorFixture";
import { gateClock, indiaDate, indiaMidnight } from "./lib/testClock";
import { tag } from "./lib/shareFixture";

const ZONES = ["Asia/Kolkata", "UTC", "America/Los_Angeles"] as const;
/** The names ICU may report for the same zone. */
const ALIASES: Record<string, string[]> = { "Asia/Kolkata": ["Asia/Kolkata", "Asia/Calcutta"], UTC: ["UTC", "Etc/UTC"] };
const PUNE = "fac-amc-pune";
const PASSWORD = "Hospital@123";
const ROOT = path.resolve(__dirname, "..");

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** hh:mm in India time, computed without the process's zone. */
const ist = (iso: string) => new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(11, 16);
const istAt = (day: string, hhmm: string) => new Date(Date.parse(`${day}T${hhmm}:00+05:30`));

async function main() {
  const now = gateClock.now();
  const today = indiaDate(now);
  const bookingDay = indiaDate(gateClock.bookingDay());
  const leaveDay = indiaDate(gateClock.indiaDay(3));
  const facility = await prisma.facility.findUniqueOrThrow({ where: { id: PUNE }, select: { timeZone: true } });
  report("A facility has a time zone, and an existing one is India's", facility.timeZone === "Asia/Kolkata", facility.timeZone);

  const v = await verifier();
  const admin = await facilityAdmin(PUNE);
  const doc = await networkDoctor(PUNE, v, admin, { specialties: ["GENERAL_MEDICINE"], name: `Dr TZ ${tag}` });
  const leaveDoctors = [];
  for (let i = 0; i < ZONES.length; i++) {
    const d = await doctorLogin(PUNE, `Dr TZ leave ${tag} ${i}`);
    await sessions(d.staffId, PUNE);
    leaveDoctors.push(d);
  }
  const patient = await prisma.patient.create({ data: { uhid: `TZ-${tag}`, facilityId: PUNE, fullName: `TZ Patient ${tag}`, sex: "F" } });

  const morning = Array.from({ length: 16 }, (_, i) => istAt(bookingDay, `${String(9 + Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`).toISOString());
  const leaveDaySlots = [
    ...Array.from({ length: 16 }, (_, i) => `${String(9 + Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`).filter((t) => t < "10:00" || t >= "11:00"),
    "18:00", "18:30",
  ].map((t) => istAt(leaveDay, t).toISOString());

  // 1–4 through the services, in a child process per server zone.
  const probes: Record<string, Record<string, unknown>> = {};
  for (const [i, zone] of ZONES.entries()) {
    const input = { now: now.toISOString(), facilityId: PUNE, staffId: doc.staffId, locationId: doc.locationId, bookingDay, leaveStaffId: leaveDoctors[i].staffId, leaveDay, oneOffDay: leaveDay };
    const r = spawnSync(path.join(ROOT, "node_modules", ".bin", "tsx"), ["scripts/lib/tzProbe.ts"], { cwd: ROOT, env: { ...process.env, TZ: zone, TZ_PROBE: JSON.stringify(input) }, encoding: "utf8", timeout: 120_000 });
    const line = r.stdout.trim().split("\n").pop() ?? "";
    try { probes[zone] = JSON.parse(line); } catch { report(`The probe runs under TZ=${zone}`, false, (r.stderr || r.stdout).slice(-800)); continue; }
    const p = probes[zone];
    report(`Probe under TZ=${zone}: the process really is in that zone`, (ALIASES[zone] ?? [zone]).includes(String(p.processTz)), String(p.processTz));
    report(`Probe under TZ=${zone}: slots on the day are 09:00–12:45 India time`, same(p.slotsByKey, morning), (p.slotsByKey as string[]).map(ist).join(","));
    report(`Probe under TZ=${zone}: the same day named by a moment in it gives the same slots`, same(p.slotsByMoment, morning));
    report(`Probe under TZ=${zone}: the person's summary day and the check-in desk's day are India's today`, p.personDay === today && p.checkInDay === today, `${p.personDay} / ${p.checkInDay}`);
    report(`Probe under TZ=${zone}: "today" starts at India midnight`, p.todayFrom === indiaMidnight(today).toISOString() && p.startOfToday === indiaMidnight(today).toISOString(), String(p.todayFrom));
    report(`Probe under TZ=${zone}: leave for a date lands on 10:00–11:00 India time that date`, same(p.leave, [istAt(leaveDay, "10:00").toISOString(), istAt(leaveDay, "11:00").toISOString()]), JSON.stringify(p.leave));
    report(`Probe under TZ=${zone}: a one-off session's date is stored as that calendar date`, p.oneOffStored === `${leaveDay}T00:00:00.000Z`, String(p.oneOffStored));
    report(`Probe under TZ=${zone}: that day's slots are the morning minus the leave hour, plus the 18:00 session`, same(p.leaveDaySlots, leaveDaySlots), (p.leaveDaySlots as string[]).map(ist).join(","));
    const next = p.nextSlot as string | null;
    const nextHhmm = next ? ist(next) : "";
    report(`Probe under TZ=${zone}: the next free slot is inside the 09:00–13:00 session, India time`, !!next && nextHhmm >= "09:00" && nextHhmm < "13:00" && Date.parse(next) > now.getTime(), next ? `${indiaDate(new Date(next))} ${nextHhmm}` : "none");
  }
  const zonesProbed = Object.keys(probes);
  if (zonesProbed.length === ZONES.length) {
    const strip = (p: Record<string, unknown>) => { const { processTz: _z, leaveDaySlots: _l, ...rest } = p; return rest; };
    report("Every answer is the same under all three server zones", zonesProbed.every((z) => same(strip(probes[z]), strip(probes[ZONES[0]]))));
  }

  // 1–3 through the running app, once per server zone.
  let booked = 0;
  for (const [i, zone] of ZONES.entries()) {
    const { base, child, serverLog } = await startServer({ TZ: zone }, { build: i === 0 ? undefined : false });
    try {
      const adminCookie = await loginAs(base, "admin@amc-demo.aarogya", PASSWORD);
      const deskCookie = await loginAs(base, "frontdesk@amc-demo.aarogya", PASSWORD);
      const get = async (cookie: string, p: string) => { const r = await fetch(base + p, { headers: { cookie } }); return { status: r.status, json: await r.json().catch(() => ({})) as Record<string, unknown> }; };
      const expected = morning.slice(booked);
      const hospital = await get(adminCookie, `/api/hospital/doctors/${doc.staffId}/slots?date=${bookingDay}`);
      const hospitalStarts = ((hospital.json.slots ?? []) as { start: string }[]).map((s) => s.start);
      report(`App under TZ=${zone}: the hospital slot list is 09:00–12:45 India time`, hospital.status === 200 && same(hospitalStarts, expected), `HTTP ${hospital.status}; ${hospitalStarts.map(ist).join(",")}`);
      const directory = await get(adminCookie, `/api/doctors/locations/${doc.locationId}/slots?date=${bookingDay}`);
      const directoryStarts = ((directory.json.slots ?? []) as { start: string }[]).map((s) => s.start);
      report(`App under TZ=${zone}: the directory's slot list agrees`, directory.status === 200 && same(directoryStarts, expected), `HTTP ${directory.status}`);

      const book = (start: Date) => fetch(base + "/api/hospital/appointments", {
        method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" },
        body: JSON.stringify({ doctorStaffId: doc.staffId, patientId: patient.id, scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + 15 * 60_000).toISOString() }),
      }).then((r) => r.status);
      const ok = await book(new Date(morning[booked]));
      report(`App under TZ=${zone}: booking ${ist(morning[booked])} India time succeeds`, ok === 200 || ok === 201, `HTTP ${ok}`);
      if (ok === 200 || ok === 201) booked += 1;
      const wrong = await book(istAt(bookingDay, "14:30"));
      report(`App under TZ=${zone}: booking 14:30 India time (09:00 UTC) is refused, outside the session`, wrong === 409, `HTTP ${wrong}`);

      const list = await get(adminCookie, `/api/hospital/appointments?date=${bookingDay}&doctorStaffId=${doc.staffId}`);
      const ours = ((list.json.appointments ?? []) as { patientId: string; scheduledStart: string }[]).filter((a) => a.patientId === patient.id);
      report(`App under TZ=${zone}: the appointments list for the day holds every booking so far`, list.status === 200 && ours.length === booked && ours.every((a) => indiaDate(new Date(a.scheduledStart)) === bookingDay), `${ours.length} of ${booked}`);
      const desk = await get(deskCookie, `/api/hospital/checkins`);
      report(`App under TZ=${zone}: the check-in desk opens on India's today`, desk.status === 200 && desk.json.day === today, `HTTP ${desk.status}; ${desk.json.day}`);
      const cc = await get(adminCookie, `/api/hospital/command-center/overview?window=today`);
      const from = (cc.json.window as { from?: string } | undefined)?.from;
      report(`App under TZ=${zone}: the command centre's "today" starts at India midnight`, cc.status === 200 && from === indiaMidnight(today).toISOString(), `HTTP ${cc.status}; ${from}`);
    } catch (e) {
      console.error(`The app's log (last lines):\n${serverLog().slice(-2000)}`);
      throw e;
    } finally {
      child.kill("SIGTERM");
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
