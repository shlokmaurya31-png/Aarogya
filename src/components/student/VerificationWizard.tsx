"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { Check, ChevronRight, ChevronLeft, GraduationCap } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { useToastStore } from "@/store/useToastStore";
import { cn } from "@/lib/utils";

const COURSES = [
  "MBBS", "BDS", "BAMS", "BHMS", "BUMS", "BSC_NURSING", "GNM", "ANM", "PHARM_D", "B_PHARM",
  "M_PHARM", "BPT", "MPT", "OCCUPATIONAL_THERAPY", "RADIOLOGY_IMAGING", "MEDICAL_LAB_TECHNOLOGY",
  "PARAMEDICAL", "PUBLIC_HEALTH", "PSYCHOLOGY", "NUTRITION_DIETETICS", "OTHER",
] as const;

const COURSE_TO_TRACK: Record<string, string> = {
  MBBS: "MEDICINE", BDS: "MEDICINE", BAMS: "MEDICINE", BHMS: "MEDICINE", BUMS: "MEDICINE",
  BSC_NURSING: "NURSING", GNM: "NURSING", ANM: "NURSING",
  PHARM_D: "PHARMACY", B_PHARM: "PHARMACY", M_PHARM: "PHARMACY",
  BPT: "PHYSIOTHERAPY", MPT: "PHYSIOTHERAPY",
  RADIOLOGY_IMAGING: "DIAGNOSTICS", MEDICAL_LAB_TECHNOLOGY: "DIAGNOSTICS",
  PUBLIC_HEALTH: "PUBLIC_HEALTH", OCCUPATIONAL_THERAPY: "PHYSIOTHERAPY",
  PARAMEDICAL: "MEDICINE", PSYCHOLOGY: "MEDICINE", NUTRITION_DIETETICS: "PUBLIC_HEALTH", OTHER: "MEDICINE",
};

const METHODS = [
  { id: "INSTITUTIONAL_EMAIL", label: "Institutional email", desc: "Use your college-issued email (e.g. @aims-demo.edu.in). Fastest — auto-verifies if the domain is registered." },
  { id: "STUDENT_ID_CARD", label: "Student ID card", desc: "Upload a photo of your current student ID for review." },
  { id: "ENROLLMENT_DOCUMENT", label: "Enrollment document", desc: "Upload a bonafide/enrollment letter from your institution." },
  { id: "MANUAL_REVIEW", label: "Manual review", desc: "No document handy — a human reviewer will follow up." },
] as const;

const STEPS = ["Who are you?", "Institution", "Program & year", "Verification method", "Review"];

export function VerificationWizard() {
  const router = useRouter();
  const push = useToastStore((s) => s.push);
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const [fullLegalName, setFullLegalName] = useState("");
  const [preferredName, setPreferredName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [institutionName, setInstitutionName] = useState("");
  const [course, setCourse] = useState<(typeof COURSES)[number]>("MBBS");
  const [academicYear, setAcademicYear] = useState(3);
  const [enrollmentYear, setEnrollmentYear] = useState(new Date().getFullYear() - 2);
  const [expectedGraduation, setExpectedGraduation] = useState(new Date().getFullYear() + 2);
  const [studentIdentifier, setStudentIdentifier] = useState("");
  const [institutionEmail, setInstitutionEmail] = useState("");
  const [clinicalInterests, setClinicalInterests] = useState("");
  const [method, setMethod] = useState<(typeof METHODS)[number]["id"]>("INSTITUTIONAL_EMAIL");
  const [file, setFile] = useState<File | null>(null);

  const canAdvance = [
    fullLegalName.trim().length > 1 && email.includes("@") && password.length >= 8,
    institutionName.trim().length > 1,
    true,
    true,
    true,
  ][step];

  async function handleSubmit() {
    setSubmitting(true);
    try {
      const form = new FormData();
      form.set("fullLegalName", fullLegalName);
      form.set("preferredName", preferredName || fullLegalName.split(" ")[0]);
      form.set("email", email);
      form.set("password", password);
      form.set("institutionName", institutionName);
      form.set("course", course);
      form.set("learningTrack", COURSE_TO_TRACK[course] ?? "MEDICINE");
      form.set("academicYear", String(academicYear));
      form.set("enrollmentYear", String(enrollmentYear));
      form.set("expectedGraduation", String(expectedGraduation));
      form.set("studentIdentifier", studentIdentifier);
      form.set("institutionEmail", institutionEmail);
      form.set("clinicalInterests", clinicalInterests);
      form.set("verificationMethod", method);
      if (file) form.set("document", file);

      const res = await fetch("/api/student/register", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) {
        push(data.error ?? "Registration failed.", "red");
        return;
      }
      push("Verification submitted.", "emerald");
      if (data.verificationStatus === "VERIFIED") {
        router.push("/student/dashboard");
      } else {
        router.push("/student/verify");
      }
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <div className="mb-8 flex items-center gap-2 text-[14px] font-semibold">
        <GraduationCap size={18} className="text-cyan" /> Aarogya Scholar Verification
      </div>

      <div className="mb-8 flex items-center gap-2">
        {STEPS.map((label, i) => (
          <div key={label} className="flex flex-1 items-center gap-2">
            <div
              className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium",
                i < step ? "border-emerald bg-emerald/10 text-emerald" : i === step ? "border-cyan bg-cyan/10 text-cyan" : "border-hairline text-text-tertiary"
              )}
            >
              {i < step ? <Check size={12} /> : i + 1}
            </div>
            {i < STEPS.length - 1 && <div className={cn("h-px flex-1", i < step ? "bg-emerald/40" : "bg-hairline")} />}
          </div>
        ))}
      </div>

      <Card className="rounded-[20px]">
        <p className="text-[15px] font-semibold">{STEPS[step]}</p>

        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -8 }}
            transition={{ duration: 0.2 }}
            className="mt-5 space-y-4"
          >
            {step === 0 && (
              <>
                <Field label="Full legal name" value={fullLegalName} onChange={setFullLegalName} required />
                <Field label="Preferred display name" value={preferredName} onChange={setPreferredName} />
                <Field label="Email (used to sign in)" value={email} onChange={setEmail} type="email" required />
                <Field label="Password (min 8 characters)" value={password} onChange={setPassword} type="password" required />
              </>
            )}

            {step === 1 && (
              <>
                <Field label="Institution name" value={institutionName} onChange={setInstitutionName} required placeholder="e.g. Aarogya Institute of Medical Sciences" />
                <Field label="Institutional email (if using METHOD A)" value={institutionEmail} onChange={setInstitutionEmail} type="email" placeholder="you@aims-demo.edu.in" />
                <Field label="Student identifier / roll number" value={studentIdentifier} onChange={setStudentIdentifier} />
              </>
            )}

            {step === 2 && (
              <>
                <div>
                  <label className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">Course / program</label>
                  <select
                    value={course}
                    onChange={(e) => setCourse(e.target.value as typeof course)}
                    className="mt-1.5 w-full rounded-md border border-hairline bg-black/[0.025] px-3 py-2.5 text-[13px] outline-none focus:border-cyan/40"
                  >
                    {COURSES.map((c) => (
                      <option key={c} value={c}>{c.replaceAll("_", " ")}</option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <NumberField label="Academic year" value={academicYear} onChange={setAcademicYear} min={1} max={7} />
                  <NumberField label="Enrollment year" value={enrollmentYear} onChange={setEnrollmentYear} min={2015} max={2030} />
                  <NumberField label="Expected graduation" value={expectedGraduation} onChange={setExpectedGraduation} min={2020} max={2035} />
                </div>
                <Field label="Clinical interests (comma-separated)" value={clinicalInterests} onChange={setClinicalInterests} placeholder="Cardiology, Emergency Medicine" />
              </>
            )}

            {step === 3 && (
              <div className="space-y-2.5">
                {METHODS.map((m) => (
                  <label
                    key={m.id}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-lg border p-3.5 transition",
                      method === m.id ? "border-cyan/40 bg-cyan/[0.06]" : "border-hairline hover:border-hairline-strong"
                    )}
                  >
                    <input type="radio" name="method" checked={method === m.id} onChange={() => setMethod(m.id)} className="mt-1" />
                    <div>
                      <p className="text-[13px] font-medium">{m.label}</p>
                      <p className="mt-0.5 text-[12px] text-text-tertiary">{m.desc}</p>
                    </div>
                  </label>
                ))}
                {(method === "STUDENT_ID_CARD" || method === "ENROLLMENT_DOCUMENT") && (
                  <div className="mt-2 rounded-lg border border-dashed border-hairline-strong p-4 text-center">
                    <input type="file" accept="image/*,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-[12px]" />
                    <p className="mt-2 text-[11px] text-text-tertiary">
                      Stored in a restricted, access-logged store — never shown in your public profile.
                    </p>
                  </div>
                )}
              </div>
            )}

            {step === 4 && (
              <div className="space-y-2 text-[13px]">
                <ReviewRow label="Name" value={fullLegalName} />
                <ReviewRow label="Email" value={email} />
                <ReviewRow label="Institution" value={institutionName} />
                <ReviewRow label="Course" value={course.replaceAll("_", " ")} />
                <ReviewRow label="Academic year" value={String(academicYear)} />
                <ReviewRow label="Verification method" value={METHODS.find((m) => m.id === method)?.label ?? ""} />
                <p className="pt-3 text-[11.5px] leading-relaxed text-text-tertiary">
                  By submitting, you confirm this information is accurate. Automated verification does
                  not guarantee legitimacy — some submissions route to manual review before you gain
                  access to Aarogya Scholar.
                </p>
              </div>
            )}
          </motion.div>
        </AnimatePresence>

        <div className="mt-6 flex items-center justify-between border-t border-hairline pt-4">
          <button
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0}
            className="flex items-center gap-1 rounded-md px-3 py-2 text-[12.5px] text-text-secondary transition hover:text-text-primary disabled:opacity-30"
          >
            <ChevronLeft size={14} /> Back
          </button>
          {step < STEPS.length - 1 ? (
            <button
              onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
              disabled={!canAdvance}
              className="flex items-center gap-1 rounded-md bg-cyan px-4 py-2 text-[12.5px] font-medium text-ink transition hover:brightness-110 disabled:opacity-40"
            >
              Continue <ChevronRight size={14} />
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="rounded-md bg-emerald px-4 py-2 text-[12.5px] font-medium text-white transition hover:brightness-110 disabled:opacity-60"
            >
              {submitting ? "Submitting..." : "Submit for verification"}
            </button>
          )}
        </div>
      </Card>
    </div>
  );
}

function Field({
  label, value, onChange, type = "text", required, placeholder,
}: { label: string; value: string; onChange: (v: string) => void; type?: string; required?: boolean; placeholder?: string }) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        type={type}
        required={required}
        placeholder={placeholder}
        className="mt-1.5 w-full rounded-md border border-hairline bg-black/[0.025] px-3 py-2.5 text-[13px] outline-none transition focus:border-cyan/40"
      />
    </div>
  );
}

function NumberField({
  label, value, onChange, min, max,
}: { label: string; value: number; onChange: (v: number) => void; min: number; max: number }) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        type="number"
        min={min}
        max={max}
        className="mt-1.5 w-full rounded-md border border-hairline bg-black/[0.025] px-3 py-2.5 text-[13px] outline-none transition focus:border-cyan/40"
      />
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-hairline py-1.5">
      <span className="text-text-tertiary">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
