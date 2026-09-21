import type { Metadata } from "next";
import {
  PageHeader, Section, Prose, CardGrid, Card, BulletList, PageCta,
} from "@/components/site/primitives";

export const metadata: Metadata = {
  title: "For Patients | Aarogya",
  description:
    "One health record that travels with you. See your appointments, reports, prescriptions and bills, control who can access your data, and grant family access — all in one secure, patient-controlled place.",
  alternates: { canonical: "/platform/patients" },
};

const CRUMB = [
  { label: "Home", href: "/" },
  { label: "Platform", href: "/platform/patients" },
  { label: "Patients", href: "/platform/patients" },
];

export default function PatientsPage() {
  return (
    <>
      <PageHeader
        breadcrumb={CRUMB}
        eyebrow="Platform · Patients"
        title="Your health, remembered"
        intro="Most of us carry our medical history on paper, scattered across hospitals that can't talk to each other. Aarogya gives you one record that follows you — and puts you in control of who sees it."
      />

      <Section title="Everything in one place" lead="What you can do the moment you sign in.">
        <CardGrid>
          <Card title="Appointments">Book, reschedule or cancel visits, and see exactly where you are in the queue.</Card>
          <Card title="Reports & prescriptions">View lab and imaging reports the moment they're released, and your prescriptions and medicines — always the latest.</Card>
          <Card title="Bills & insurance">See what you owe (calculated by the hospital, never guessed), your coverage and your claim status.</Card>
          <Card title="Consent & family">Grant or revoke who can access your record, and give a parent, spouse or caregiver bounded, revocable access.</Card>
        </CardGrid>
      </Section>

      <Section title="You are in control" lead="Access is yours to give and to take back.">
        <BulletList
          items={[
            <><strong>You own your record.</strong> Nothing is shared without your explicit, revocable consent.</>,
            <><strong>You see only what's yours.</strong> Records are released to you when your clinician finalizes them — never a half-finished draft.</>,
            <><strong>Family access, on your terms.</strong> Invite someone you trust to see specific parts of your record, with an expiry, and revoke it any time.</>,
            <><strong>Honest about the rest.</strong> Where something isn't ready yet — online payment, a national health-ID link — Aarogya tells you plainly instead of pretending.</>,
          ]}
        />
      </Section>

      <Section title="Built to reach you anywhere">
        <Prose>
          <p>
            The patient experience is designed to feel calm and human — simple language instead of hospital
            jargon, and a responsive design that works on the phone in your pocket. Your record is the same
            whether you open it at home or at the hospital front desk.
          </p>
        </Prose>
      </Section>

      <PageCta
        title="Take your health record with you"
        body="Sign in to your patient portal and see your care in one place."
        actions={[
          { label: "Open the patient portal", href: "/patient/login", primary: true },
          { label: "How consent works", href: "/standards/dpdp" },
        ]}
      />
    </>
  );
}
