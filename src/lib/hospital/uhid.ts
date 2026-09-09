import { prisma } from "@/lib/db";

/**
 * Server-side Aarogya UHID generation (brief §5). Format:
 * UHID-<facility-code>-<random>. The real uniqueness backstop is the
 * `Patient.uhid @unique` DB constraint — a duplicate can never persist. This
 * helper additionally makes the rare random collision graceful: it pre-checks
 * and, on the unique index, retries with a fresh value instead of surfacing a
 * raw P2002 500. Concurrent patient creation therefore never produces a
 * duplicate UHID and never fails on a collision it can simply retry past.
 */
function randomUhid(facilityId: string): string {
  const code = facilityId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 4).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `UHID-${code}-${rand}`;
}

/**
 * Returns a UHID not currently present in the DB. This is a best-effort
 * pre-check; callers must still rely on the `@unique` constraint as the
 * authoritative guard (and catch P2002 to retry the create if a concurrent
 * insert claimed the same value between this check and the write —
 * `createPatientWithUhid` does exactly that).
 */
export async function generateCandidateUhid(facilityId: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = randomUhid(facilityId);
    const existing = await prisma.patient.findUnique({ where: { uhid: candidate }, select: { id: true } });
    if (!existing) return candidate;
  }
  // Extremely unlikely: 5 collisions in a row. Fall through to a
  // timestamp-suffixed value the create will still validate against @unique.
  return `${randomUhid(facilityId)}-${Date.now().toString(36).toUpperCase()}`;
}

function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002");
}

/**
 * Runs a patient-creation callback with a freshly generated unique UHID,
 * retrying on the (rare) case where a concurrent insert claimed the candidate
 * UHID between generation and write (P2002). The callback receives the UHID
 * to use and performs the actual `prisma.patient.create` (optionally inside
 * its own transaction, e.g. the self-service registration flow that also
 * creates a linked Patient row).
 */
export async function createPatientWithUhid<T>(
  facilityId: string,
  create: (uhid: string) => Promise<T>
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const uhid = await generateCandidateUhid(facilityId);
    try {
      return await create(uhid);
    } catch (err) {
      if (isUniqueViolation(err) && attempt < 4) continue;
      throw err;
    }
  }
  throw new Error("Could not generate a unique UHID after multiple attempts.");
}
