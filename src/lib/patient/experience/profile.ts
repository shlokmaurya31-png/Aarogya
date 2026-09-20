import { prisma } from "@/lib/db";
import { z } from "zod";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import type { PatientAccessScope } from "../context";

/**
 * Phase D11 — patient profile & preferences (brief §6, §46).
 *
 * Read + a NARROW, explicitly-mapped update. Mass assignment is structurally
 * impossible: only the fields in ProfileUpdateSchema can ever be written, and
 * identity/clinical/financial/tenant fields (patientId, uhid, facilityId, sex,
 * dob, registrationStatus, userId, mergedIntoId, ...) are never accepted. Only
 * the patient themselves may edit their own profile.
 */

export interface ProfileDTO {
  fullName: string;
  preferredName: string | null;
  sex: string;
  dob: string | null;
  phone: string | null;
  address: string | null;
  language: string | null;
  communicationPreference: string | null;
  bloodGroup: string | null;
  uhidMasked: string;
  emergencyContacts: { name: string; relation: string; phone: string }[];
}

export async function getProfile(scope: PatientAccessScope): Promise<ProfileDTO> {
  const p = await prisma.patient.findUnique({
    where: { id: scope.patientId },
    include: { emergencyContacts: { orderBy: { priority: "asc" } } },
  });
  if (!p) throw new NotFoundError();
  return {
    fullName: p.fullName,
    preferredName: p.preferredName,
    sex: p.sex,
    dob: p.dob?.toISOString() ?? null,
    phone: p.phone,
    address: p.address,
    language: p.language,
    communicationPreference: p.communicationPreference,
    bloodGroup: p.bloodGroup,
    uhidMasked: p.uhid.length > 4 ? "•".repeat(p.uhid.length - 4) + p.uhid.slice(-4) : p.uhid,
    emergencyContacts: p.emergencyContacts.map((c) => ({ name: c.name, relation: c.relation, phone: c.phone })),
  };
}

/** The ONLY patient-editable fields. Everything else is immutable to the patient. */
const ProfileUpdateSchema = z
  .object({
    preferredName: z.string().max(120).nullish(),
    phone: z.string().max(40).nullish(),
    address: z.string().max(500).nullish(),
    language: z.string().max(16).nullish(),
    communicationPreference: z.enum(["SMS", "EMAIL", "CALL", "NONE"]).nullish(),
  })
  .strict(); // reject any unexpected key outright

export async function updateProfile(scope: PatientAccessScope, body: unknown): Promise<ProfileDTO> {
  if (!scope.isSelf) throw new NotFoundError();
  const parsed = ProfileUpdateSchema.safeParse(body);
  if (!parsed.success) throw new BadRequestError("Only contact and communication preferences can be updated.");
  const data = parsed.data;
  // Explicit field-by-field mapping — never spread the request body.
  await prisma.patient.update({
    where: { id: scope.patientId },
    data: {
      preferredName: data.preferredName ?? undefined,
      phone: data.phone ?? undefined,
      address: data.address ?? undefined,
      language: data.language ?? undefined,
      communicationPreference: data.communicationPreference ?? undefined,
    },
  });
  return getProfile(scope);
}
