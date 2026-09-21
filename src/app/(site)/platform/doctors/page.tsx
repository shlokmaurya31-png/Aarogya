import type { Metadata } from "next";
import {
  PageHeader, Section, Prose, CardGrid, Card, BulletList, PageCta,
} from "@/components/site/primitives";

export const metadata: Metadata = {
  title: "For Doctors | Aarogya",
  description:
    "A decision made with the full picture, not a blind spot. Aarogya gives clinicians one longitudinal chart, safe ordering, and the whole care team on the same record.",
  alternates: { canonical: "/platform/doctors" },
};

const CRUMB = [
  { label: "Home", href: "/" },
  { label: "Platform", href: "/platform/patients" },
  { label: "Doctors", href: "/platform/doctors" },
];

export default function DoctorsPage() {
  return (
    <>
      <PageHeader
        breadcrumb={CRUMB}
        eyebrow="Platform · Doctors"
        title="The full picture, at the point of care"
        intro="A clinician making a decision without the prior record is making it with a blind spot. Aarogya puts the patient's whole longitudinal chart — and a safe way to act on it — in front of you when it matters."
      />

      <Section title="Everything the chart should be" lead="One record, not ten disconnected systems.">
        <CardGrid>
          <Card title="Longitudinal chart">Visits, diagnoses, problems, allergies, medications, results and documents — merge-aware, in one timeline.</Card>
          <Card title="Safe ordering">Place medication, lab and imaging orders through one order model, with the safety checks and status the rest of the team can see.</Card>
          <Card title="Diagnostics & results">Track lab and imaging turnaround, verify and release results, and act on critical findings with a clear acknowledgement trail.</Card>
          <Card title="Team on one record">Nurses, pharmacy, diagnostics and billing all work off the same canonical record — no faxing, no re-keying.</Card>
        </CardGrid>
      </Section>

      <Section title="Designed for how clinicians actually work">
        <BulletList
          items={[
            <><strong>Your patients, first.</strong> A focused worklist gets you to the people you're caring for, not a maze of menus.</>,
            <><strong>Coded, not just typed.</strong> A terminology layer keeps clinical meaning machine-readable (FHIR R4, SNOMED CT) so the record adds up over time.</>,
            <><strong>Authorized and audited.</strong> Access follows role and consent, and sensitive actions are audited — protection you don't have to think about.</>,
          ]}
        />
      </Section>

      <Section title="Part of a real hospital system">
        <Prose>
          <p>
            The clinician experience isn't a standalone app — it's one view onto Aarogya&rsquo;s Hospital
            Operating System, so an order you place flows to pharmacy, a result flows back to you, and the
            command centre sees the whole picture. Doctor and hospital staff accounts are provisioned by your
            organization&rsquo;s administrator.
          </p>
        </Prose>
      </Section>

      <PageCta
        title="See the whole patient"
        body="Sign in to your clinical workspace, or ask us to bring Aarogya to your hospital."
        actions={[
          { label: "Sign in", href: "/login", primary: true },
          { label: "Talk to us", href: "/company/contact" },
        ]}
      />
    </>
  );
}
