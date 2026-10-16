import { PrismaClient } from "@prisma/client";
import { createItem } from "../../src/lib/hospital/inventory/items";
import { createTariff } from "../../src/lib/hospital/billing/pricing";
import { staffAtFacilityWhere } from "../../src/lib/auth/staffFacility";

/**
 * Batch 6, fix 5: a small, realistic clinical catalogue per facility, each
 * entry with its own cash tariff, so charge-capture prices the common cases
 * from a specific tariff instead of the generic one:
 *
 *   procedures   PROCEDURE:<code>   with typical OT durations
 *   blood        BLOOD:<code>       the main components (PRBC, FFP, platelets, cryo)
 *   implants     ITEM:<sku>         stent, knee, hip, IOL, plate set
 *
 * Prices are illustrative demo values in INR (minor units), in the range of
 * Indian private-hospital package rates and published ceilings; they are not a
 * rate card. Idempotent: an existing procedure, product, item or live tariff is
 * left alone. Runs before seedChargeCaptureTariffs, whose flat implant rate
 * then skips these items.
 */
const PROCEDURES = [
  { code: "LAP_CHOLE", name: "Laparoscopic cholecystectomy", specialty: "General Surgery", minutes: 90, rupees: 65_000 },
  { code: "LAP_APPENDIX", name: "Laparoscopic appendicectomy", specialty: "General Surgery", minutes: 60, rupees: 50_000 },
  { code: "HERNIA_MESH", name: "Inguinal hernia repair with mesh", specialty: "General Surgery", minutes: 75, rupees: 55_000 },
  { code: "PTCA", name: "Coronary angioplasty (PTCA) with stenting", specialty: "Cardiology", minutes: 90, rupees: 150_000 },
  { code: "LSCS", name: "Lower segment caesarean section", specialty: "Obstetrics", minutes: 60, rupees: 60_000 },
  { code: "TKR", name: "Total knee replacement", specialty: "Orthopaedics", minutes: 150, rupees: 175_000 },
  { code: "THR", name: "Total hip replacement", specialty: "Orthopaedics", minutes: 165, rupees: 200_000 },
  { code: "ORIF", name: "Open reduction and internal fixation", specialty: "Orthopaedics", minutes: 120, rupees: 85_000 },
  { code: "PHACO_IOL", name: "Phacoemulsification with IOL implantation", specialty: "Ophthalmology", minutes: 30, rupees: 25_000 },
  { code: "TURP", name: "Transurethral resection of the prostate", specialty: "Urology", minutes: 75, rupees: 75_000 },
] as const;

const BLOOD = [
  { code: "PRBC", name: "Packed red blood cells", componentType: "PRBC", unit: "1 unit (~280 ml)", storage: "2–6 °C", rupees: 1_550 },
  { code: "FFP", name: "Fresh frozen plasma", componentType: "FFP", unit: "1 unit (~200 ml)", storage: "≤ −30 °C", rupees: 400 },
  { code: "PLT", name: "Random donor platelets", componentType: "PLATELETS", unit: "1 unit (~50 ml)", storage: "20–24 °C, agitated", rupees: 400 },
  { code: "CRYO", name: "Cryoprecipitate", componentType: "CRYOPRECIPITATE", unit: "1 unit (~15 ml)", storage: "≤ −30 °C", rupees: 200 },
] as const;

const IMPLANTS = [
  { key: "DES", name: "Drug-eluting coronary stent", rupees: 30_000 },
  { key: "KNEE", name: "Total knee implant system (cobalt-chromium)", rupees: 55_000 },
  { key: "HIP", name: "Total hip implant system (uncemented)", rupees: 65_000 },
  { key: "IOL", name: "Foldable intraocular lens", rupees: 8_000 },
  { key: "PLATE", name: "Locking plate and screw set", rupees: 18_000 },
] as const;

/** The seeded implant SKU for a facility (SKUs are unique across facilities). */
export const implantSku = (key: (typeof IMPLANTS)[number]["key"], facilityId: string) => `IMP-${key}-${facilityId}`;

export async function seedClinicalCatalogue(prisma: PrismaClient) {
  const effectiveFrom = new Date("2026-01-01");
  const cashPayer = await prisma.payer.findUnique({ where: { id: "payer-cash-selfpay" } });
  if (!cashPayer) return;
  const counts = { procedures: 0, blood: 0, implants: 0, tariffs: 0 };
  for (const facility of await prisma.facility.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] })) {
    const actor = await prisma.hospitalStaffProfile.findFirst({ where: { ...staffAtFacilityWhere(facility.id), user: { role: { in: ["BILLING_STAFF", "HOSPITAL_ADMIN"] } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    if (!actor) continue;
    const tariff = async (chargeCode: string, description: string, category: string, rupees: number) => {
      if (await prisma.tariff.count({ where: { facilityId: facility.id, payerId: cashPayer.id, chargeCode, active: true } })) return;
      await prisma.$transaction((tx) => createTariff(tx, { facilityId: facility.id, payerId: cashPayer.id, chargeCode, description, category, unitPriceMinor: rupees * 100, effectiveFrom, createdByUserId: actor.userId }));
      counts.tariffs++;
    };

    for (const p of PROCEDURES) {
      if (!(await prisma.procedure.findUnique({ where: { facilityId_code: { facilityId: facility.id, code: p.code } } }))) {
        await prisma.procedure.create({ data: { facilityId: facility.id, code: p.code, name: p.name, specialty: p.specialty, typicalDurationMinutes: p.minutes } });
        counts.procedures++;
      }
      await tariff(`PROCEDURE:${p.code}`, p.name, "PROCEDURE", p.rupees);
    }
    for (const b of BLOOD) {
      if (!(await prisma.bloodProduct.findUnique({ where: { facilityId_code: { facilityId: facility.id, code: b.code } } }))) {
        await prisma.bloodProduct.create({ data: { facilityId: facility.id, code: b.code, name: b.name, componentType: b.componentType, defaultUnitDescription: b.unit, storageRequirement: b.storage } });
        counts.blood++;
      }
      await tariff(`BLOOD:${b.code}`, b.name, "OTHER", b.rupees);
    }
    for (const i of IMPLANTS) {
      const sku = implantSku(i.key, facility.id);
      if (!(await prisma.item.findUnique({ where: { sku } }))) {
        await prisma.$transaction((tx) => createItem(tx, { facilityId: facility.id, sku, name: i.name, category: "IMPLANT", baseUnit: "PIECE" }));
        counts.implants++;
      }
      await tariff(`ITEM:${sku}`, i.name, "OTHER", i.rupees);
    }
  }
  console.log(`Clinical catalogue: ${counts.procedures} procedures, ${counts.blood} blood components, ${counts.implants} implants, ${counts.tariffs} tariffs created.`);
}
