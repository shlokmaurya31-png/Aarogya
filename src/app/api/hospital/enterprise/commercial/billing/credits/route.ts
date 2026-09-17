import { NextRequest } from "next/server";
import { z } from "zod";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { issueCredit, applyCreditToInvoice, listCredits } from "@/lib/billing/credits";

/** Tenant-scoped list of an organization's active credits. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("commercial:read");
    const organizationId = req.nextUrl.searchParams.get("organizationId");
    if (!organizationId) throw new BadRequestError("organizationId is required.");
    return { credits: await listCredits(m, organizationId) };
  });
}

const issueSchema = z.object({
  action: z.literal("issue"),
  organizationId: z.string().min(1),
  amountMinor: z.number().int().positive(),
  type: z.enum(["PROMOTIONAL", "MANUAL", "CORRECTION", "CONTRACT"]),
  reason: z.string().min(1),
});
const applySchema = z.object({
  action: z.literal("apply"),
  creditId: z.string().min(1),
  invoiceId: z.string().min(1),
  amountMinor: z.number().int().positive(),
});

/** Platform-only: issue a credit, or apply one to a DRAFT invoice. No self-credit. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("commercial:platform:manage");
    const body = await req.json().catch(() => null);
    const issue = issueSchema.safeParse(body);
    if (issue.success) {
      const { organizationId, amountMinor, type, reason } = issue.data;
      return { credit: await issueCredit(m, { organizationId, amountMinor, type, reason }) };
    }
    const apply = applySchema.safeParse(body);
    if (apply.success) {
      const { creditId, invoiceId, amountMinor } = apply.data;
      return { invoice: await applyCreditToInvoice(m, { creditId, invoiceId, amountMinor }) };
    }
    throw new BadRequestError("Invalid input: expected an issue or apply action.");
  });
}
