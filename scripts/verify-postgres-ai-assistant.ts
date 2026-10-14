/**
 * The portal assistant (/api/chat) answers from the REAL record, scoped to the
 * caller, through the AI provider boundary.
 *
 *   - A patient's context is built from their own record (via the patient
 *     portal's readers): real allergies and active medicines, nothing from
 *     src/lib/mock-data.ts, nothing from another patient or facility.
 *   - Asking for a patient outside the caller's accessible set is a 404.
 *   - A delegate sees only the data classes shared with them.
 *   - A clinician's context is the one chart they were authorized for.
 *   - With no model configured, the mock provider answers honestly.
 *
 * Links a test PATIENT-role user to a seeded patient; run on a throwaway
 * database (verify:all resets it). Usage:
 *   DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-ai-assistant.ts
 */
import { Role } from "@prisma/client";
import { prisma } from "../src/lib/db";
import { NotFoundError } from "../src/lib/auth/rbac";
import { resolveReadScope, type PatientAccessScope, type PatientContext } from "../src/lib/patient/context";
import { listMedications } from "../src/lib/patient/experience/medications";
import { patientAssistantContext, clinicianAssistantContext } from "../src/lib/ai/assistantContext";
import { MockAIProvider } from "../src/lib/ai/mockProvider";
import { patient as mockPatient } from "../src/lib/mock-data";

// Mirrors src/lib/patient/experience/medications.ts (what the portal calls "active").
const ACTIVE_MED_STATUSES = ["ORDERED", "VERIFIED", "DISPENSED", "ACTIVE"] as const;

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

async function main() {
  // A Pune patient with an active allergy AND an active medicine (so both
  // checks below are meaningful), linked to a portal account.
  const target = await prisma.patient.findFirstOrThrow({
    where: {
      facilityId: "fac-amc-pune", userId: null, mergedIntoId: null,
      allergies: { some: { status: "ACTIVE" } },
      medicationOrders: { some: { status: { in: [...ACTIVE_MED_STATUSES] } } },
    },
    include: { allergies: { where: { status: "ACTIVE" } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const user = await prisma.user.upsert({
    where: { email: "ai-assistant-patient@verify.aarogya" },
    update: {},
    create: { email: "ai-assistant-patient@verify.aarogya", displayName: "AI assistant patient", role: Role.PATIENT, passwordHash: "x" },
  });
  await prisma.patient.updateMany({ where: { userId: user.id, id: { not: target.id } }, data: { userId: null } });
  await prisma.patient.update({ where: { id: target.id }, data: { userId: user.id } });
  const ctx: PatientContext = { session: { userId: user.id, role: Role.PATIENT } as PatientContext["session"], userId: user.id, selfPatientId: target.id };

  // 1. The patient's own record.
  const scope = await resolveReadScope(ctx);
  const context = await patientAssistantContext(scope);
  const allergies = target.allergies.map((a) => a.substance);
  report("Patient context lists the patient's real allergies", allergies.every((a) => context.includes(a)), allergies.join(", "));
  const activeMeds = (await listMedications(scope)).filter((m) => m.isActive).map((m) => m.drug);
  // The context is deliberately small: each section shows its 8 most recent
  // entries (listMedications is newest first).
  const shown = activeMeds.slice(0, 8);
  report("Patient context lists the patient's most recent active medicines", shown.length > 0 && shown.every((d) => context.includes(d)), shown.join(", "));
  if (activeMeds.length > 8) {
    const medLines = (context.split("ACTIVE MEDICINES\n")[1] ?? "").split("\n\n")[0].split("\n").filter((l) => l.startsWith("- "));
    report("Patient context stays capped at 8 medicines", medLines.length === 8, `${medLines.length} shown of ${activeMeds.length} active`);
  }
  report("Patient context contains nothing from mock-data.ts", !context.includes(mockPatient.name) && !context.includes(mockPatient.patientId));
  const others = await prisma.patient.findMany({ where: { id: { not: target.id } }, select: { fullName: true }, take: 200, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const leaked = others.map((o) => o.fullName).filter((n) => n && n !== target.fullName && context.includes(n));
  report("Patient context names no other patient", leaked.length === 0, leaked.slice(0, 3).join(", "));

  // 2. A patient outside the caller's accessible set is a 404.
  const stranger = await prisma.patient.findFirstOrThrow({ where: { facilityId: "fac-amc-noida" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const strangerScope = await resolveReadScope(ctx, stranger.id).then(() => "resolved", (e) => (e instanceof NotFoundError ? "404" : String(e)));
  report("Asking about another facility's patient is a 404", strangerScope === "404", strangerScope);

  // 3. A delegate with only APPOINTMENTS shared sees no clinical sections.
  const delegate: PatientAccessScope = { ...scope, isSelf: false, delegationId: "verify-delegation", allowedClasses: new Set(["APPOINTMENTS"]) };
  const delegated = await patientAssistantContext(delegate);
  report(
    "A delegate without RECORDS sees no allergies",
    delegated.includes("ALLERGIES\n(not shared with this account)") && allergies.every((a) => !delegated.includes(a))
  );
  report("A delegate's context says it is a delegated view", delegated.includes("delegated access"));

  // 4. The clinician context is the authorized chart.
  const chart = await clinicianAssistantContext(target.id);
  report("Clinician context is the real chart", chart.includes(target.uhid) && allergies.every((a) => chart.includes(a)));

  // 5. No model configured: the mock provider is honest.
  const reply = await new MockAIProvider().assistantReply({ audience: "patient", context, message: "What are my allergies?" });
  report("Mock provider says the assistant isn't connected, and invents nothing", reply.includes("isn't connected") && allergies.every((a) => !reply.includes(a)));

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
