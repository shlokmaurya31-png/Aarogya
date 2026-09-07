import type { Prisma } from "@prisma/client";
import { BadRequestError } from "@/lib/auth/rbac";

type Tx = Prisma.TransactionClient;

export interface CreateSupplierInput {
  facilityId: string;
  name: string;
  code: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
  address?: string;
  paymentTermsDays?: number;
}

export async function createSupplier(tx: Tx, input: CreateSupplierInput) {
  const existing = await tx.supplier.findUnique({ where: { facilityId_code: { facilityId: input.facilityId, code: input.code } } });
  if (existing) throw new BadRequestError(`Supplier code "${input.code}" already exists at this facility.`);
  return tx.supplier.create({ data: input });
}

export async function updateSupplier(tx: Tx, id: string, facilityId: string, input: Partial<Omit<CreateSupplierInput, "facilityId" | "code">> & { active?: boolean }) {
  const supplier = await tx.supplier.findUniqueOrThrow({ where: { id } });
  if (supplier.facilityId !== facilityId) throw new BadRequestError("Supplier not found.");
  return tx.supplier.update({ where: { id }, data: input });
}

export async function listSuppliers(tx: Tx, facilityId: string, opts: { active?: boolean } = {}) {
  return tx.supplier.findMany({ where: { facilityId, active: opts.active }, orderBy: { name: "asc" } });
}
