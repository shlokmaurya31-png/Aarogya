import type { ConsultMode } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { getAvailableSlots } from "@/lib/hospital/doctorSchedule";
import { locationFeeMinor } from "./locations";
import { FALLBACK_SPECIALTY, LANGUAGES, SPECIALTIES, SPECIALTY_CODES, STATE_COUNCILS, type Specialty } from "./vocab";

/**
 * Week 5a — the public directory (docs/DOCTOR_NETWORK_DESIGN.md §6, §8).
 * Only VERIFIED, listed doctors with an active location appear, and only
 * their public fields: name, council and registration number, "registered
 * since" (the verified registration year, never a claimed experience),
 * qualifications, specialties, languages, and each location's fee, modes,
 * public address and next slot. Never the doctor's login, contacts,
 * documents or verification case. Search never reads the searcher's record
 * (no personalisation from health data) and nothing ranks by payment.
 *
 * Ranking is deterministic: specialty match (primary first), then distance,
 * then next slot, then fee, then name.
 */
export interface SearchQuery {
  specialty?: string; symptom?: string; language?: string; mode?: string; maxFeeMinor?: number;
  near?: { lat: number; lng: number; km: number }; slotWithinDays?: number; limit?: number;
}

const R_KM = 6371;
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function parseSearch(q: URLSearchParams): SearchQuery {
  const num = (k: string) => (q.get(k) === null || q.get(k) === "" ? undefined : Number(q.get(k)));
  const out: SearchQuery = {};
  const specialty = q.get("specialty");
  if (specialty) { if (!SPECIALTY_CODES.includes(specialty as Specialty)) throw new BadRequestError("Unknown specialty."); out.specialty = specialty; }
  const symptom = q.get("symptom"); if (symptom) out.symptom = symptom.toUpperCase().slice(0, 40);
  const language = q.get("language");
  if (language) { if (!(LANGUAGES as readonly string[]).includes(language)) throw new BadRequestError("Unknown language."); out.language = language; }
  const mode = q.get("mode");
  if (mode) { if (mode !== "IN_PERSON" && mode !== "VIDEO") throw new BadRequestError("mode must be IN_PERSON or VIDEO."); out.mode = mode; }
  const fee = num("maxFee"); if (fee !== undefined) { if (!Number.isFinite(fee) || fee < 0) throw new BadRequestError("maxFee is not valid."); out.maxFeeMinor = Math.round(fee * 100); }
  const lat = num("lat"), lng = num("lng"), km = num("km");
  if (lat !== undefined || lng !== undefined) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new BadRequestError("lat and lng go together.");
    out.near = { lat: lat!, lng: lng!, km: Number.isFinite(km) && km! > 0 ? Math.min(km!, 500) : 25 };
  }
  const within = num("slotWithinDays"); if (within !== undefined) { if (!Number.isInteger(within) || within < 0 || within > 30) throw new BadRequestError("slotWithinDays is 0–30."); out.slotWithinDays = within; }
  return out;
}

/** The approved-or-pending version of the symptom map in use (the latest version), as specialties for a symptom. */
export async function specialtiesForSymptom(code: string): Promise<{ specialties: Specialty[]; version: number | null; pendingClinicalAdvisor: boolean }> {
  const latest = await prisma.symptomSpecialtyMap.findFirst({ orderBy: { version: "desc" }, select: { version: true } });
  if (!latest) return { specialties: [], version: null, pendingClinicalAdvisor: true };
  const rows = await prisma.symptomSpecialtyMap.findMany({ where: { version: latest.version, symptomCode: code }, orderBy: [{ weight: "desc" }, { specialty: "asc" }] });
  return { specialties: rows.map((r) => r.specialty as Specialty), version: latest.version, pendingClinicalAdvisor: rows.some((r) => r.reviewStatus !== "APPROVED") || rows.length === 0 };
}

export async function symptomList() {
  const latest = await prisma.symptomSpecialtyMap.findFirst({ orderBy: { version: "desc" }, select: { version: true } });
  if (!latest) return { version: null, symptoms: [] };
  const rows = await prisma.symptomSpecialtyMap.findMany({ where: { version: latest.version }, distinct: ["symptomCode"], orderBy: { label: "asc" }, select: { symptomCode: true, label: true, reviewStatus: true } });
  return { version: latest.version, pendingClinicalAdvisor: rows.some((r) => r.reviewStatus !== "APPROVED"), symptoms: rows.map((r) => ({ code: r.symptomCode, label: r.label })) };
}

const publicDoctor = {
  id: true, displayName: true, registrationNumber: true, stateCouncil: true, registrationYear: true, languages: true,
  specialties: { select: { specialty: true, primary: true } }, qualifications: { select: { degree: true, institution: true, year: true } },
} as const;

export interface DirectoryLocation {
  id: string; kind: "HOSPITAL" | "CLINIC"; facilityName: string; city: string | null; addressLine: string | null; pincode: string | null;
  modes: ConsultMode[]; feeMinor: number | null; distanceKm: number | null; nextSlotAt: string | null;
}
export interface DirectoryEntry {
  doctorId: string; name: string; council: string; registrationNumber: string; registeredSince: number | null;
  specialties: { code: string; label: string; primary: boolean }[]; qualifications: { degree: string; institution: string; year: number | null }[];
  languages: string[]; locations: DirectoryLocation[];
}

/** The public directory, filtered in SQL first (verified, listed, active locations, specialty, language, mode, slot window), then by fee and distance. */
export async function searchDirectory(q: SearchQuery) {
  let specialties: string[] | undefined = q.specialty ? [q.specialty] : undefined;
  let symptom: Awaited<ReturnType<typeof specialtiesForSymptom>> | null = null;
  if (q.symptom) {
    symptom = await specialtiesForSymptom(q.symptom);
    specialties = [...new Set([...(specialties ?? []), ...symptom.specialties])];
    if (!specialties.length) specialties = [FALLBACK_SPECIALTY];
  }
  const now = new Date();
  const slotBy = q.slotWithinDays !== undefined ? new Date(now.getTime() + (q.slotWithinDays + 1) * 86_400_000) : undefined;
  const doctors = await prisma.doctorProfile.findMany({
    where: {
      verificationStatus: "VERIFIED", listed: true,
      ...(specialties ? { specialties: { some: { specialty: { in: specialties } } } } : {}),
      ...(q.language ? { languages: { has: q.language } } : {}),
      locations: { some: { active: true, ...(q.mode ? { modes: { has: q.mode as ConsultMode } } : {}) } },
    },
    select: {
      ...publicDoctor,
      locations: {
        where: { active: true, ...(q.mode ? { modes: { has: q.mode as ConsultMode } } : {}), ...(slotBy ? { nextSlot: { nextSlotAt: { gte: now, lt: slotBy } } } : {}) },
        select: { id: true, kind: true, facilityId: true, feeMinor: true, modes: true, addressLine: true, pincode: true, lat: true, lng: true, nextSlot: { select: { nextSlotAt: true } } },
      },
    },
    take: 500,
  });
  const facilities = await prisma.facility.findMany({ where: { id: { in: doctors.flatMap((d) => d.locations.map((l) => l.facilityId)) }, status: "ACTIVE" }, select: { id: true, name: true, city: true } });
  const entries: (DirectoryEntry & { rank: [number, number, number, number, string] })[] = [];
  for (const d of doctors) {
    const locations: DirectoryLocation[] = [];
    for (const l of d.locations) {
      const f = facilities.find((x) => x.id === l.facilityId);
      if (!f) continue;
      const feeMinor = await locationFeeMinor(l, now);
      if (q.maxFeeMinor !== undefined && (feeMinor === null || feeMinor > q.maxFeeMinor)) continue;
      const distanceKm = q.near && l.lat !== null && l.lng !== null ? Math.round(haversineKm(q.near, { lat: l.lat, lng: l.lng }) * 10) / 10 : null;
      if (q.near && (distanceKm === null || distanceKm > q.near.km)) continue;
      const next = l.nextSlot?.nextSlotAt && l.nextSlot.nextSlotAt >= now ? l.nextSlot.nextSlotAt : null;
      locations.push({ id: l.id, kind: l.kind, facilityName: f.name, city: f.city, addressLine: l.addressLine, pincode: l.pincode, modes: l.modes, feeMinor, distanceKm, nextSlotAt: next?.toISOString() ?? null });
    }
    if (!locations.length) continue;
    locations.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9) || (a.nextSlotAt ?? "~").localeCompare(b.nextSlotAt ?? "~") || (a.feeMinor ?? 1e12) - (b.feeMinor ?? 1e12));
    const best = locations[0];
    const match = specialties ? (d.specialties.some((s) => s.primary && specialties!.includes(s.specialty)) ? 0 : 1) : 0;
    entries.push({
      doctorId: d.id, name: d.displayName, council: STATE_COUNCILS[d.stateCouncil as keyof typeof STATE_COUNCILS] ?? d.stateCouncil, registrationNumber: d.registrationNumber,
      registeredSince: d.registrationYear,
      specialties: d.specialties.map((s) => ({ code: s.specialty, label: SPECIALTIES[s.specialty as Specialty] ?? s.specialty, primary: s.primary })).sort((a, b) => Number(b.primary) - Number(a.primary)),
      qualifications: d.qualifications, languages: d.languages, locations,
      rank: [match, best.distanceKm ?? 1e9, best.nextSlotAt ? Date.parse(best.nextSlotAt) : 9e15, best.feeMinor ?? 1e12, d.displayName],
    });
  }
  entries.sort((a, b) => {
    for (let i = 0; i < 4; i++) if (a.rank[i] !== b.rank[i]) return (a.rank[i] as number) - (b.rank[i] as number);
    return a.rank[4].localeCompare(b.rank[4]) || a.doctorId.localeCompare(b.doctorId);
  });
  return {
    results: entries.slice(0, Math.min(q.limit ?? 50, 100)).map(({ rank: _rank, ...e }) => e),
    ...(symptom ? { symptom: { specialties: symptom.specialties, version: symptom.version, pendingClinicalAdvisor: symptom.pendingClinicalAdvisor, alsoGeneralPhysician: true } } : {}),
  };
}

/** One public profile (verified and listed only; anything else is a 404). */
export async function publicProfile(doctorId: string) {
  const r = await searchDirectory({});
  const hit = r.results.find((e) => e.doctorId === doctorId);
  if (!hit) throw new NotFoundError();
  return hit;
}

/** Live slots for one location on one day (the facility's day: a YYYY-MM-DD key or the day containing a moment): the engine's own computation, this location's facility only. */
export async function locationSlots(locationId: string, day: Date | string) {
  const loc = await prisma.practiceLocation.findUnique({ where: { id: locationId }, include: { doctor: { select: { verificationStatus: true, listed: true } } } });
  if (!loc || !loc.active || loc.doctor.verificationStatus !== "VERIFIED" || !loc.doctor.listed) throw new NotFoundError();
  const now = Date.now();
  return (await getAvailableSlots(loc.staffId, day, { facilityId: loc.facilityId })).filter((s) => Date.parse(s.start) > now);
}
