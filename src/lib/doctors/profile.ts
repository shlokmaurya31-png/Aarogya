import type { DoctorProfile, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitDomainEvent } from "@/lib/events/emit";
import { DEGREES, LANGUAGES, SPECIALTY_CODES, STATE_COUNCILS, type Specialty } from "./vocab";

/**
 * Week 5a — the doctor's professional identity (docs/DOCTOR_NETWORK_DESIGN.md
 * §2, §3, §8). A DoctorProfile belongs to the doctor's own DOCTOR login and to
 * no facility and no Person: a doctor who is also a patient has a separate
 * patient login and Person, and the two are never joined (decision 2).
 * Doctor-owned reads and writes go through requireOwnDoctor.
 */
export async function requireOwnDoctor(userId: string): Promise<DoctorProfile> {
  const d = await prisma.doctorProfile.findUnique({ where: { userId } });
  if (!d) throw new NotFoundError();
  return d;
}

const str = (v: unknown, name: string, max = 120): string => {
  if (typeof v !== "string" || !v.trim()) throw new BadRequestError(`${name} is required.`);
  return v.trim().slice(0, max);
};

export interface ProfileInput {
  displayName?: unknown; registrationNumber?: unknown; stateCouncil?: unknown; registrationYear?: unknown;
  languages?: unknown; specialties?: unknown; primarySpecialty?: unknown; qualifications?: unknown;
}

function parseLanguages(v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !(LANGUAGES as readonly string[]).includes(x))) throw new BadRequestError(`languages must be some of ${LANGUAGES.join(", ")}.`);
  return [...new Set(v as string[])];
}

function parseSpecialties(v: unknown, primary: unknown): { specialty: Specialty; primary: boolean }[] {
  if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== "string" || !SPECIALTY_CODES.includes(x as Specialty))) throw new BadRequestError("Choose at least one specialty from the list.");
  const list = [...new Set(v as Specialty[])];
  const p = typeof primary === "string" && list.includes(primary as Specialty) ? primary : list[0];
  return list.map((s) => ({ specialty: s, primary: s === p }));
}

function parseQualifications(v: unknown): { degree: string; institution: string; year: number | null }[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new BadRequestError("qualifications must be a list.");
  return v.map((q) => {
    const o = (q ?? {}) as Record<string, unknown>;
    if (typeof o.degree !== "string" || !(o.degree in DEGREES)) throw new BadRequestError(`degree must be one of ${Object.keys(DEGREES).join(", ")}.`);
    const year = o.year === undefined || o.year === null ? null : Number(o.year);
    if (year !== null && (!Number.isInteger(year) || year < 1950 || year > new Date().getFullYear())) throw new BadRequestError("A qualification's year is not valid.");
    return { degree: o.degree, institution: str(o.institution, "institution", 200), year };
  });
}

/**
 * The doctor registers (their own DOCTOR login): registration number and
 * council, the claimed registration year, specialties, languages,
 * qualifications. Starts UNVERIFIED and unlisted; nothing is public until the
 * platform team verifies it against the medical register.
 */
export async function registerDoctor(userId: string, input: ProfileInput) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, displayName: true } });
  if (user?.role !== "DOCTOR") throw new BadRequestError("Only a doctor's login can register a doctor profile.");
  if (await prisma.doctorProfile.findUnique({ where: { userId }, select: { id: true } })) throw new ConflictError("You already have a doctor profile.");
  const stateCouncil = str(input.stateCouncil, "stateCouncil", 10);
  if (!(stateCouncil in STATE_COUNCILS)) throw new BadRequestError("stateCouncil is not a known medical council.");
  const registrationNumber = str(input.registrationNumber, "registrationNumber", 40).toUpperCase();
  const year = input.registrationYear === undefined || input.registrationYear === null ? null : Number(input.registrationYear);
  if (year !== null && (!Number.isInteger(year) || year < 1950 || year > new Date().getFullYear())) throw new BadRequestError("registrationYear is not valid.");
  const specialties = parseSpecialties(input.specialties, input.primarySpecialty);
  const qualifications = parseQualifications(input.qualifications);
  const languages = parseLanguages(input.languages);
  if (await prisma.doctorProfile.findUnique({ where: { stateCouncil_registrationNumber: { stateCouncil, registrationNumber } }, select: { id: true } })) {
    throw new ConflictError("This registration is already claimed by another profile. Contact support if it is yours.");
  }
  const doctor = await prisma.$transaction(async (tx) => {
    const d = await tx.doctorProfile.create({
      data: {
        userId, displayName: typeof input.displayName === "string" && input.displayName.trim() ? input.displayName.trim().slice(0, 120) : user.displayName,
        registrationNumber, stateCouncil, registrationYear: year, languages,
        specialties: { create: specialties }, qualifications: { create: qualifications },
      },
    });
    await emitDomainEvent(tx, { type: "DoctorRegistered", aggregateId: d.id, actorUserId: userId, payload: { doctorId: d.id, stateCouncil } });
    return d;
  });
  await recordAuditEvent("doctor.registered", userId, { doctorId: doctor.id, stateCouncil });
  return doctor;
}

/** Public-facing fields the doctor may change themselves. Registration details change only through verification. */
export async function updateOwnProfile(userId: string, input: { languages?: unknown; specialties?: unknown; primarySpecialty?: unknown; listed?: unknown; displayName?: unknown }) {
  const d = await requireOwnDoctor(userId);
  const fields: string[] = [];
  await prisma.$transaction(async (tx) => {
    const data: Prisma.DoctorProfileUpdateInput = {};
    if (input.languages !== undefined) { data.languages = parseLanguages(input.languages); fields.push("languages"); }
    if (input.displayName !== undefined) { data.displayName = str(input.displayName, "displayName"); fields.push("displayName"); }
    if (input.listed !== undefined) {
      if (typeof input.listed !== "boolean") throw new BadRequestError("listed must be true or false.");
      if (input.listed && d.verificationStatus !== "VERIFIED") throw new ConflictError("You can be listed once your registration is verified.");
      data.listed = input.listed; fields.push("listed");
    }
    if (input.specialties !== undefined) {
      const list = parseSpecialties(input.specialties, input.primarySpecialty);
      await tx.doctorSpecialty.deleteMany({ where: { doctorId: d.id } });
      await tx.doctorSpecialty.createMany({ data: list.map((s) => ({ doctorId: d.id, ...s })) });
      fields.push("specialties");
    }
    if (!fields.length) throw new BadRequestError("Nothing to change.");
    const r = await tx.doctorProfile.updateMany({ where: { id: d.id, version: d.version }, data: { ...(data as Prisma.DoctorProfileUpdateManyMutationInput), version: { increment: 1 } } });
    if (r.count !== 1) throw new ConflictError("Your profile changed in the meantime. Reload and try again.");
    await emitDomainEvent(tx, { type: "DoctorProfileUpdated", aggregateId: d.id, actorUserId: userId, payload: { doctorId: d.id, fields } });
  });
  return prisma.doctorProfile.findUniqueOrThrow({ where: { id: d.id }, include: { specialties: true, qualifications: true } });
}

/** The doctor's own view: everything about their profile, cases (without document refs), links and locations. */
export async function ownDoctorView(userId: string) {
  const d = await requireOwnDoctor(userId);
  const full = await prisma.doctorProfile.findUniqueOrThrow({
    where: { id: d.id },
    include: { specialties: true, qualifications: true, staffLinks: true, locations: { include: { nextSlot: true } }, cases: { orderBy: { createdAt: "desc" }, select: { id: true, status: true, dueAt: true, decidedAt: true, reasonCode: true, createdAt: true } } },
  });
  return full;
}
