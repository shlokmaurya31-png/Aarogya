import { NextRequest } from "next/server";
import { requireVerifiedStudent } from "@/lib/auth/currentStudent";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { validatePrescription } from "@/lib/rxlab/validate";
import { getActiveCaseProvider } from "@/lib/clinical/gateway";
import type { PrescriptionContext } from "@/types/clinicalCase";
import type { PrescriptionEntry } from "@/lib/caseEngine/types";

const FREEFORM_CONTEXT: PrescriptionContext = {
  allergies: [],
  pregnancyStatus: "not-applicable",
  renalFunction: "normal",
  hepaticFunction: "normal",
  currentMedications: [],
  diagnoses: [],
};

/** Standalone RxLab: validates against either a case's prescriptionContext (if caseId given) or a freeform default context for practice without a case. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    await requireVerifiedStudent("student:rx:simulate");
    const body = await req.json().catch(() => null);
    const drugs = body?.drugs as PrescriptionEntry[] | undefined;
    const caseId = body?.caseId as string | undefined;
    if (!drugs || !Array.isArray(drugs)) throw new BadRequestError("drugs[] is required.");

    let context = FREEFORM_CONTEXT;
    if (caseId) {
      const provider = getActiveCaseProvider();
      const full = await provider.getCaseFull(caseId);
      if (full) context = full.content.prescriptionContext;
    }

    const warnings = validatePrescription(drugs, context);
    return { warnings, context };
  });
}
