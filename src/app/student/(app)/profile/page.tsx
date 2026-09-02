import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/getCurrentUser";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";

export default async function StudentProfilePage() {
  const user = await getCurrentUser();
  if (!user || !user.studentProfile) redirect("/student");
  const p = user.studentProfile;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-[20px] font-semibold tracking-tight">Profile</h1>

      <Card className="mt-5 rounded-[20px]">
        <div className="flex items-center gap-3">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-cyan/10 text-[18px] font-semibold text-cyan">
            {p.fullLegalName.split(" ").map((n) => n[0]).slice(0, 2).join("")}
          </div>
          <div>
            <p className="text-[15px] font-semibold">{p.fullLegalName}</p>
            <p className="text-[12px] text-text-tertiary">{user.email}</p>
          </div>
          <StatusPill label={p.verificationStatus} tone="emerald" className="ml-auto rounded-md" />
        </div>

        <div className="mt-5 grid grid-cols-2 gap-4 border-t border-hairline pt-4 text-[13px]">
          <Field label="Institution" value={p.institution?.name ?? p.institutionNameFreeText ?? "—"} />
          <Field label="Course" value={p.course.replaceAll("_", " ")} />
          <Field label="Learning track" value={p.learningTrack.replaceAll("_", " ")} />
          <Field label="Academic year" value={String(p.academicYear)} />
          <Field label="Enrollment year" value={String(p.enrollmentYear)} />
          <Field label="Expected graduation" value={String(p.expectedGraduation)} />
          <Field label="Current rotation" value={p.currentRotation ?? "—"} />
          <Field label="Clinical interests" value={JSON.parse(p.clinicalInterests || "[]").join(", ") || "—"} />
        </div>
      </Card>

      <Card className="mt-4 rounded-[20px]">
        <CardLabel>Privacy</CardLabel>
        <p className="mt-2 text-[12.5px] leading-relaxed text-text-tertiary">
          Verification documents, if any were uploaded, are stored in a restricted store and never shown
          here or sent to other students. See the platform privacy notes for details.
        </p>
      </Card>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary">{label}</p>
      <p className="mt-0.5">{value}</p>
    </div>
  );
}
