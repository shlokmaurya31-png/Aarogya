/**
 * Flagship 4e — offline mode per ward, behind the clinical advisor's sign-off
 * (docs/OFFLINE_NURSING_DESIGN.md §6, §13.5).
 *
 *   1. A ward starts with offline mode off: no pack.
 *   2. With no sign-off, turning it on is refused.
 *   3. Only platform staff record the sign-off (name, reference, date; not in
 *      the future); audited, with its event; one active at a time.
 *   4. The hospital admin turns the ward on, with a reason (audited, event);
 *      packs follow; another facility's admin gets a 404.
 *   5. Off again: no pack and no renewal, but what a device recorded still
 *      syncs (a recorded fact is never refused for this).
 *   6. Revoking the sign-off turns offline mode off on every ward.
 *
 * Usage: through `npm run verify:all`.
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { ensurePrimaryMembership } from "../prisma/seedData/staffMembership";
import { roleHasPermission } from "../src/lib/auth/permissions";
import { issuePack, registerWardDevice, renewLeases, syncCommands } from "../src/lib/hospital/offline/service";
import { activeSignOff, OfflineModeOffError, recordClinicalSignOff, revokeClinicalSignOff, setWardOfflineMode } from "../src/lib/hospital/offline/switch";
import { tag } from "./lib/shareFixture";

const PUNE = "fac-amc-pune";
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

async function staff(facilityId: string, role: "NURSE" | "HOSPITAL_ADMIN" | "AAROGYA_ADMIN") {
  seq += 1;
  const dept = await prisma.department.findFirstOrThrow({ where: { facilityId }, select: { id: true } });
  const user = await prisma.user.create({ data: { email: `switch-${role.toLowerCase()}-${tag}-${seq}@verify.aarogya`, passwordHash: "x", role, displayName: `Switch ${role} ${seq}` } });
  if (role === "AAROGYA_ADMIN") return { userId: user.id, staffId: "", facilityId };
  const s = await prisma.hospitalStaffProfile.create({ data: { userId: user.id, departmentId: dept.id, displayRole: role } });
  await ensurePrimaryMembership(prisma, user.id, facilityId, { isAdmin: role === "HOSPITAL_ADMIN" });
  return { userId: user.id, staffId: s.id, facilityId };
}

async function main() {
  const admin = await staff(PUNE, "HOSPITAL_ADMIN");
  const noidaAdmin = await staff(NOIDA, "HOSPITAL_ADMIN");
  const nurse = await staff(PUNE, "NURSE");
  const platform = await staff(PUNE, "AAROGYA_ADMIN");
  const P = { userId: platform.userId };
  const N = { userId: nurse.userId, staffId: nurse.staffId, facilityId: PUNE };
  const dept = await prisma.department.findFirstOrThrow({ where: { facilityId: PUNE }, select: { id: true } });
  const ward = await prisma.ward.create({ data: { facilityId: PUNE, name: `Switch ward ${tag}`, wardType: "GENERAL", departmentId: dept.id } });
  const dev = await registerWardDevice(admin, { wardId: ward.id, label: `Switch tablet ${tag}` });

  // 1. Off by default.
  report("A ward starts with offline mode off", !(await prisma.ward.findUniqueOrThrow({ where: { id: ward.id } })).offlineEnabled);
  report("…and its devices get no pack", await issuePack(N, { deviceId: dev.id }).then(() => false, (e) => e instanceof OfflineModeOffError));

  // 2. No sign-off: refused. (Another gate may have left one: revoke it first, as platform staff would.)
  const left = await activeSignOff();
  if (left) await revokeClinicalSignOff(P, left.id, { reason: "verify-postgres-offline-switch: starting from no sign-off" });
  report("With the clinical sign-off pending, turning offline mode on is refused", await refusedWith(setWardOfflineMode(admin, ward.id, { enabled: true, reason: "Ward 3 pilot" }), "ConflictError") && !(await prisma.ward.findUniqueOrThrow({ where: { id: ward.id } })).offlineEnabled);

  // 3. The sign-off.
  report("Only platform staff record the sign-off", roleHasPermission("AAROGYA_ADMIN", "platform:clinical-sign-off:record") && !roleHasPermission("HOSPITAL_ADMIN", "platform:clinical-sign-off:record") && !roleHasPermission("NURSE", "platform:clinical-sign-off:record"));
  report("…with the advisor's name, the document's reference and the date", await refusedWith(recordClinicalSignOff(P, { advisorName: "Dr Advisor", signedOffAt: new Date().toISOString() }), "BadRequestError")
    && await refusedWith(recordClinicalSignOff(P, { advisorName: "Dr Advisor", reference: "DOC-1", signedOffAt: new Date(Date.now() + 86_400_000).toISOString() }), "BadRequestError"));
  const signOff = await recordClinicalSignOff(P, { advisorName: `Dr Synthetic Advisor ${tag}`, reference: `CLIN-RULES-S6-${tag}`, signedOffAt: new Date(Date.now() - 3_600_000).toISOString() });
  report("Recorded: audited, with its event", (await prisma.auditEvent.count({ where: { type: "platform.clinical-sign-off.recorded", userId: platform.userId } })) === 1 && (await prisma.domainEventOutbox.count({ where: { eventType: "ClinicalSignOffRecorded", aggregateId: signOff.id } })) === 1);
  report("…one active at a time", await refusedWith(recordClinicalSignOff(P, { advisorName: "Another", reference: "DOC-2", signedOffAt: new Date().toISOString() }), "ConflictError"));

  // 4. On.
  report("Turning it on needs a reason", await refusedWith(setWardOfflineMode(admin, ward.id, { enabled: true, reason: "" }), "BadRequestError"));
  report("Another facility's admin can't (404)", await refusedWith(setWardOfflineMode(noidaAdmin, ward.id, { enabled: true, reason: "x" }), "NotFoundError"));
  const on = await setWardOfflineMode(admin, ward.id, { enabled: true, reason: `Ward pilot agreed with the nursing director ${tag}` });
  report("With the sign-off, the hospital admin turns it on: audited, with its event", on.offlineEnabled && on.changed
    && (await prisma.auditEvent.count({ where: { type: "hospital.offline.ward-mode.changed", userId: admin.userId } })) === 1
    && (await prisma.domainEventOutbox.count({ where: { eventType: "WardOfflineModeChanged", aggregateId: ward.id } })) === 1);
  const pack = await issuePack(N, { deviceId: dev.id });
  report("…and packs follow", Boolean(pack.packId));

  // 5. Off again.
  const cmd = { clientOperationId: `sw-${tag}-1`, kind: "VITALS", encounterId: "none", vitals: { hr: 80 }, deviceTime: new Date().toISOString() };
  await setWardOfflineMode(admin, ward.id, { enabled: false, reason: "Pilot paused" });
  report("Off: no pack", await issuePack(N, { deviceId: dev.id }).then(() => false, (e) => e instanceof OfflineModeOffError));
  report("…and no renewal", await renewLeases(N, { deviceId: dev.id, packId: pack.packId }).then(() => false, (e) => e instanceof OfflineModeOffError));
  const s = await syncCommands(N, { deviceId: dev.id, commands: [cmd] });
  report("…but what a device recorded still syncs (kept, never refused for this)", s.results.length === 1 && (await prisma.offlineCommand.count({ where: { clientOperationId: `sw-${tag}-1` } })) === 1);

  // 6. Revoking the sign-off.
  await setWardOfflineMode(admin, ward.id, { enabled: true, reason: "Pilot resumed" });
  report("A revocation needs a reason", await refusedWith(revokeClinicalSignOff(P, signOff.id, { reason: "" }), "BadRequestError"));
  const r = await revokeClinicalSignOff(P, signOff.id, { reason: `The advisor asked to review the PRN rules ${tag}` });
  report("Revoking the sign-off turns offline mode off on every ward", r.revoked && (await prisma.ward.count({ where: { offlineEnabled: true } })) === 0 && (await prisma.domainEventOutbox.count({ where: { eventType: "WardOfflineModeChanged", aggregateId: ward.id, payload: { path: ["cause"], equals: "SIGN_OFF_REVOKED" } } })) === 1);
  report("…audited, with its event", (await prisma.auditEvent.count({ where: { type: "platform.clinical-sign-off.revoked", userId: platform.userId } })) >= 1 && (await prisma.domainEventOutbox.count({ where: { eventType: "ClinicalSignOffRevoked", aggregateId: signOff.id } })) === 1);
  report("…and turning a ward on is refused again", await refusedWith(setWardOfflineMode(admin, ward.id, { enabled: true, reason: "again" }), "ConflictError"));

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
