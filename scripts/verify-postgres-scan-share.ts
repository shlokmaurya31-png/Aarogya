/**
 * Flagship 6 — Scan and Share check-in with the mock ABDM gateway
 * (docs/ABDM_CERTIFICATION_PLAN.md §8).
 *
 *   1. Counters and their QR: a signed link per counter; a QR not signed by
 *      Aarogya, or for another facility's counter, is refused (404).
 *   2. A shared profile with no record here: in the check-in queue with the
 *      day's token, the gateway told the token, the ABHA number kept only as a
 *      hash and its last 4; shared again (same request), the same check-in.
 *   3. Refused whole, nothing kept: an Aadhaar-like number anywhere in the
 *      profile; an ABHA the gateway can't verify. No column can hold an
 *      Aadhaar number.
 *   4. A known record (by its verified ABHA number, exactly): straight into
 *      the registration queue, with its events.
 *   5. The desk: registers a waiting one from the shared profile (no form)
 *      and queues it, audited; or queues it for an exact UHID; never twice;
 *      another facility's staff get a 404.
 *   6. From the patient's app: the profile built from their own Person.
 *   7. Only the mock adapter exists.
 *
 * Usage: through `npm run verify:all`.
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { ensurePrimaryMembership } from "../prisma/seedData/staffMembership";
import { registerPatientAccount } from "../src/lib/patient/selfRegistration";
import { countersWithQr, createCounter, deskQueue, queueCheckIn, receiveProfileShare, scanTarget, shareFromApp } from "../src/lib/hospital/scanShare/service";
import { mockAbhaNumber, mockAcks, scanShareGateway, type AbdmProfileShare } from "../src/lib/hospital/interoperability/abdm/scanShare";
import { tag } from "./lib/shareFixture";

const NOIDA = "fac-amc-noida";
let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const refusedWith = <T>(p: Promise<T>, name: string) => p.then(() => false, (e) => (e as Error).constructor.name === name);
let seq = 0;

async function main() {
  // A facility of its own, so the day's tokens start at S-001.
  const pune = await prisma.facility.findUniqueOrThrow({ where: { id: "fac-amc-pune" }, select: { organizationId: true } });
  const fac = await prisma.facility.create({ data: { name: `Scan and Share ${tag}`, organizationId: pune.organizationId } });
  const dept = await prisma.department.create({ data: { facilityId: fac.id, name: "OPD" } });
  const user = await prisma.user.create({ data: { email: `scan-desk-${tag}@verify.aarogya`, passwordHash: "x", role: "HOSPITAL_ADMIN", displayName: "Scan desk" } });
  await prisma.hospitalStaffProfile.create({ data: { userId: user.id, departmentId: dept.id, displayRole: "HOSPITAL_ADMIN" } });
  await ensurePrimaryMembership(prisma, user.id, fac.id, { isAdmin: true });
  const desk = { userId: user.id, facilityId: fac.id };
  const share = (abhaAddress: string, extra: Partial<AbdmProfileShare["profile"]> = {}, requestId = `req-${tag}-${++seq}`): AbdmProfileShare => ({
    requestId, timestamp: new Date().toISOString(), hipId: fac.id, counterId: "OPD-1",
    profile: { abhaNumber: null, abhaAddress, name: `Scan Person ${seq}`, gender: "F", yearOfBirth: 1984, monthOfBirth: 6, dayOfBirth: 9, phoneNumber: "+919812345678", ...extra },
  });
  const rows = () => prisma.scanShareCheckIn.count({ where: { facilityId: fac.id } });

  // 1. Counters and their QR.
  report("A counter needs a code and a label", await refusedWith(createCounter(desk, { code: "!", label: "" }), "BadRequestError"));
  await createCounter(desk, { code: "opd-1", label: "OPD registration" });
  report("…and its code is the facility's once", await refusedWith(createCounter(desk, { code: "OPD-1", label: "Again" }), "ConflictError") && (await prisma.domainEventOutbox.count({ where: { facilityId: fac.id, eventType: "ScanShareCounterCreated" } })) === 1);
  const [qr] = await countersWithQr(fac.id, "https://aarogya.example");
  const sig = new URL(qr.url).searchParams.get("sig")!;
  report("Each counter has a signed QR link (and its SVG)", qr.url.startsWith("https://aarogya.example/patient/scan?hip=") && qr.svg.startsWith("<svg") && sig.length > 8);
  report("A QR Aarogya didn't sign is refused", await refusedWith(scanTarget(fac.id, "OPD-1", "forged"), "NotFoundError"));
  report("…and so is another facility's id with this counter", await refusedWith(scanTarget(NOIDA, "OPD-1", sig), "NotFoundError"));
  report("A signed QR names the facility and counter", (await scanTarget(fac.id, "OPD-1", sig)).counter === "OPD registration");

  // 2. No record here: the check-in queue.
  const s1 = share(`asha${tag}@sbx`);
  const r1 = await receiveProfileShare(s1);
  const ci1 = await prisma.scanShareCheckIn.findUniqueOrThrow({ where: { id: r1.checkInId } });
  report("A profile with no record here waits in the check-in queue, with the day's first token", r1.status === "WAITING" && r1.token === "S-001" && !r1.matched);
  report("…the gateway is told the token (on-share)", mockAcks.some((a) => a.requestId === s1.requestId && a.tokenNumber === "S-001"));
  const number = mockAbhaNumber(`asha${tag}@sbx`);
  report("…the ABHA number kept only as a hash and its last 4", ci1.abhaNumberLast4 === number.slice(-4) && !JSON.stringify(ci1).includes(number));
  report("…with its event (ids only)", (await prisma.domainEventOutbox.findFirstOrThrow({ where: { eventType: "ScanShareReceived", aggregateId: ci1.id } })).payload !== null && !JSON.stringify((await prisma.domainEventOutbox.findFirstOrThrow({ where: { aggregateId: ci1.id } })).payload).includes("Scan Person"));
  const again = await receiveProfileShare(s1);
  report("Shared again (the same request): the same check-in", again.replayed && again.checkInId === r1.checkInId && (await rows()) === 1);

  // 3. Refused whole.
  const before = await rows();
  report("An Aadhaar-like number in the profile: refused, nothing kept", await refusedWith(receiveProfileShare(share(`a2${tag}@sbx`, { name: "Ravi 1234 5678 9012" })), "BadRequestError")
    && await refusedWith(receiveProfileShare(share(`a3${tag}@sbx`, { phoneNumber: "1234-5678-9012" })), "BadRequestError") && (await rows()) === before);
  report("An ABHA the gateway can't verify: refused, nothing kept", await refusedWith(receiveProfileShare(share(`inactive${tag}@sbx`)), "ConflictError") && await refusedWith(receiveProfileShare(share("not an abha")), "ConflictError") && (await rows()) === before);
  const cols = await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name IN ('ScanShareCheckIn', 'ScanShareCounter')`;
  report("No column can hold an Aadhaar number", cols.length > 10 && !cols.some((c) => /aadha/i.test(c.column_name)));

  // 4. A known record, by its verified ABHA number.
  const known = await prisma.patient.create({ data: { facilityId: fac.id, uhid: `SCAN-${tag}`, fullName: "Known Patient", sex: "M" } });
  const knownAddr = `known${tag}@sbx`;
  await prisma.externalIdentifier.create({ data: { facilityId: fac.id, entityType: "PATIENT", entityId: known.id, system: "https://healthid.abdm.gov.in", value: mockAbhaNumber(knownAddr), status: "ACTIVE", verificationStatus: "VERIFIED" } });
  const r2 = await receiveProfileShare(share(knownAddr, { gender: "M" }));
  const q2 = await prisma.queueEntry.findFirst({ where: { patientId: known.id, queueType: "REGISTRATION" } });
  report("A known record goes straight into the registration queue", r2.status === "QUEUED" && r2.matched && r2.token === "S-002" && Boolean(q2));
  report("…with its events", (await prisma.domainEventOutbox.count({ where: { aggregateId: r2.checkInId, eventType: { in: ["ScanShareReceived", "ScanShareQueued"] } } })) === 2);

  // 5. The desk.
  const noidaDesk = { userId: user.id, facilityId: NOIDA };
  report("Another facility's staff can't touch the check-in (404)", await refusedWith(queueCheckIn(noidaDesk, r1.checkInId, {}), "NotFoundError"));
  report("A UHID that isn't this facility's is refused", await refusedWith(queueCheckIn(desk, r1.checkInId, { uhid: "UHID-NOPE" }), "NotFoundError"));
  const done = await queueCheckIn(desk, r1.checkInId, {});
  const reg = await prisma.patient.findUniqueOrThrow({ where: { id: done.patientId } });
  report("The desk registers a waiting one from the shared profile and queues it", done.registered && reg.fullName === ci1.name && reg.sex === "F" && reg.dob?.toISOString().startsWith("1984-06-09") === true && reg.phone === "+919812345678" && (await prisma.queueEntry.count({ where: { patientId: reg.id } })) === 1);
  report("…audited, with the patient's registration event", (await prisma.auditEvent.count({ where: { type: "hospital.scan-share.queued", userId: user.id } })) === 1 && (await prisma.domainEventOutbox.count({ where: { eventType: "PatientRegistered", aggregateId: reg.id } })) === 1);
  report("…never twice", await refusedWith(queueCheckIn(desk, r1.checkInId, {}), "ConflictError"));
  const r3 = await receiveProfileShare(share(`third${tag}@sbx`));
  const viaUhid = await queueCheckIn(desk, r3.checkInId, { uhid: known.uhid });
  report("…or queues one for an existing record, by its exact UHID", !viaUhid.registered && viaUhid.patientId === known.id);
  const list = await deskQueue(fac.id);
  report("The desk sees the day's tokens in order", JSON.stringify(list.checkIns.map((c) => c.token)) === JSON.stringify(["S-001", "S-002", "S-003"]) && list.checkIns.every((c) => c.status === "QUEUED"));

  // 6. From the patient's app.
  const acct = await registerPatientAccount({ fullName: `App Patient ${tag}`, email: `scan-app-${tag}@verify.aarogya`, passwordHash: "x", sex: "M", dob: new Date("1979-11-02") });
  if (acct.status !== "LINKED_NEW") throw new Error("fixture");
  const fromApp = await shareFromApp(acct.userId, { hip: fac.id, counter: "OPD-1", sig, abhaAddress: `app${tag}@sbx` });
  const ci4 = await prisma.scanShareCheckIn.findFirstOrThrow({ where: { facilityId: fac.id, token: fromApp.token } });
  report("From the app: the profile is the patient's own, and they get a token", fromApp.token === "S-004" && ci4.name === `App Patient ${tag}` && ci4.sex === "M" && ci4.yearOfBirth === 1979);
  report("…only with a QR Aarogya signed", await refusedWith(shareFromApp(acct.userId, { hip: fac.id, counter: "OPD-1", sig: "forged", abhaAddress: `app${tag}@sbx` }), "NotFoundError"));

  // 7. The adapter.
  process.env.ABDM_SCAN_SHARE_MODE = "sandbox";
  report("Only the mock adapter exists (the sandbox one waits for the verified spec)", (() => { try { scanShareGateway(); return false; } catch { return true; } })());
  delete process.env.ABDM_SCAN_SHARE_MODE;

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
