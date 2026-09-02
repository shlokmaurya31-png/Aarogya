import { PrescriptionForm } from "@/components/student/PrescriptionForm";

export default function StudentRxLabPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-[20px] font-semibold tracking-tight">RxLab</h1>
      <p className="mt-1 text-[13px] text-text-secondary">
        Free-practice prescription simulator. Enter a prescription and check it for allergy, duplicate-therapy,
        renal/hepatic and interaction issues. Open a case from the Clinical Feed for context-aware validation
        against a specific patient.
      </p>
      <div className="mt-5">
        <PrescriptionForm />
      </div>
    </div>
  );
}
