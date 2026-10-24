/**
 * Week 5a — the directory gives no access (docs/DOCTOR_NETWORK_DESIGN.md §8, §10),
 * zero tolerance. A verified, listed directory doctor with no care
 * relationship and no share asks about a patient by every way in (the shared
 * view with a guessed id, the AI, an upload's download): nothing, and the
 * canaries never appear. Being booked without a share gives nothing either.
 * Positive control: with a booking share, exactly its categories (a LABS-only
 * share shows the lab canary and not the medicine one, nor a note).
 * Search never reads the searcher: the results are the same for any searcher
 * and for none, and carry no patient data.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-doctor-leaks.ts
 */
import "./lib/gateBootstrap";
import { randomBytes } from "node:crypto";
import { prisma } from "../src/lib/db";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { bookThroughDirectory } from "../src/lib/doctors/booking";
import { searchDirectory } from "../src/lib/doctors/directory";
import { viewSharedRecord } from "../src/lib/sharing/view";
import { askAi, AskError } from "../src/lib/rag/ask";
import { personDocumentDownload } from "../src/lib/person/documents";
import { NOIDA, drain, lab, medicine, notFound, reporter, sharer, tag, upload } from "./lib/shareFixture";
import { daySlots, facilityAdmin, networkDoctor, verifier } from "./lib/doctorFixture";

const { report, done } = reporter();
process.env.AI_TEXT_KEY_VERSION = "1";
process.env.AI_TEXT_KEY_1 = randomBytes(32).toString("base64");
const canary = (k: string) => `dncanary${k}${tag}`;

async function main() {
  registerAllConsumers();
  const v = await verifier();
  const admin = await facilityAdmin(NOIDA);
  const doc = await networkDoctor(NOIDA, v, admin, { name: `Dr Leak ${tag}`, specialties: ["GENERAL_MEDICINE"] });
  const P = await sharer();
  await lab(P.pune, P.punEnc, "Ferritin", `12 ${canary("lab")}`);
  await medicine(P.pune, P.punEnc, `Drug ${canary("rx")}`);
  const up = await upload(P.personId, `Upload ${canary("up")}`);
  await drain();
  const staffActor = { kind: "STAFF" as const, userId: doc.userId, role: "DOCTOR" as const, facilityId: NOIDA };
  const asked = (patientId: string, shareId?: string) => askAi(staffActor, { mode: "VISIT_BRIEF", patientId, ...(shareId ? { shareId } : {}) }).then((r) => JSON.stringify(r), (e) => (e instanceof AskError ? `refused ${e.status}` : "error"));
  const all = (s: string) => [canary("lab"), canary("rx"), canary("up")].every((c) => !s.includes(c));

  // No share, no care relationship.
  const ai = await asked(P.pune);
  report("No share: the directory doctor's AI about the patient's record is refused, no canary", ai === "refused 404" && all(ai));
  const shareIds = (await prisma.recordShare.findMany({ where: { personId: P.personId }, select: { id: true } })).map((s) => s.id);
  report("No share exists, and a guessed id opens nothing (404)", shareIds.length === 0 && await notFound(viewSharedRecord({ userId: doc.userId, facilityId: NOIDA, role: "DOCTOR" }, P.pune, "SHARED_RECORD_VIEW")));
  report("The patient's upload can't be opened by guessing a share (404)", await notFound(personDocumentDownload({ kind: "SHARE", userId: doc.userId, facilityId: NOIDA, role: "DOCTOR", shareRef: P.pune }, up)));

  // Booked without a share.
  const [s1, s2] = (await daySlots(doc.locationId!, 2)).slots;
  const plain = await bookThroughDirectory(P.userId, { locationId: doc.locationId, start: s1.start });
  const noidaRecord = (await prisma.appointment.findUniqueOrThrow({ where: { id: plain.appointmentId } })).patientId;
  await prisma.encounter.deleteMany({ where: { patientId: noidaRecord } });
  const ai2 = await asked(noidaRecord);
  report("Booked without a share: still nothing of the patient's Pune record (404), no canary", ai2 === "refused 404" && all(ai2));

  // Positive control: a LABS-only booking share.
  const withShare = await bookThroughDirectory(P.userId, { locationId: doc.locationId, start: s2.start, share: { categories: ["LABS"] } });
  await prisma.recordShare.update({ where: { id: withShare.shareId! }, data: { validFrom: new Date(Date.now() - 60_000) } });
  const view = JSON.stringify((await viewSharedRecord({ userId: doc.userId, facilityId: NOIDA, role: "DOCTOR" }, withShare.shareId!, "SHARED_RECORD_VIEW")).history);
  report("With a LABS-only booking share: the lab canary is there (control)", view.includes(canary("lab")));
  report("…the medicine and the upload are not", !view.includes(canary("rx")) && !view.includes(canary("up")));
  const ai3 = await asked(noidaRecord, withShare.shareId!);
  report("…and the AI through it cites no medicine or upload", !ai3.includes(canary("rx")) && !ai3.includes(canary("up")));
  report("…nor opens the upload (404)", await notFound(personDocumentDownload({ kind: "SHARE", userId: doc.userId, facilityId: NOIDA, role: "DOCTOR", shareRef: withShare.shareId! }, up)));

  // Search never reads the searcher.
  const s = JSON.stringify(await searchDirectory({ specialty: "GENERAL_MEDICINE" }));
  report("Search results carry no patient data", all(s) && !s.includes(P.personId) && !s.includes(P.pune));

  await done();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
