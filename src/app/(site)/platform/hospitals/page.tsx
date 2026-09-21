import type { Metadata } from "next";
import {
  PageHeader, Section, Prose, CardGrid, Card, BulletList, PageCta,
} from "@/components/site/primitives";

export const metadata: Metadata = {
  title: "For Hospitals | Aarogya",
  description:
    "A complete hospital operating system on one canonical record — clinical, diagnostics, pharmacy, beds, billing and a real-time command centre — with multi-facility tenancy and honest interoperability.",
  alternates: { canonical: "/platform/hospitals" },
};

const CRUMB = [
  { label: "Home", href: "/" },
  { label: "Platform", href: "/platform/patients" },
  { label: "Hospitals", href: "/platform/hospitals" },
];

export default function HospitalsPage() {
  return (
    <>
      <PageHeader
        breadcrumb={CRUMB}
        eyebrow="Platform · Hospitals"
        title="One operating system for the whole hospital"
        intro="Aarogya runs the hospital on a single canonical record — from the front desk to the ICU to the billing desk — and gives leadership a live view of what is actually happening, and why."
      />

      <Section title="The whole hospital, one record" lead="Not a suite of disconnected modules bolted together.">
        <CardGrid>
          <Card title="Clinical & flow">Front desk, ED, beds, admissions, transfers, discharge, ICU, operating theatre and blood bank — one patient journey.</Card>
          <Card title="Diagnostics & pharmacy">Laboratory, radiology and pharmacy with real lifecycles, turnaround tracking and inventory.</Card>
          <Card title="Revenue cycle">Charges, invoices, payments, insurance, pre-authorization and claims — including the NHCX exchange boundary.</Card>
          <Card title="Command Center 2.0">A real-time operational view where every metric answers WHY, with configurable thresholds and honest &ldquo;unavailable&rdquo; states.</Card>
        </CardGrid>
      </Section>

      <Section title="Built for many facilities" lead="Enterprise from the foundation, not as an afterthought.">
        <BulletList
          items={[
            <><strong>Multi-facility tenancy.</strong> Organizations, facilities, memberships and hierarchical configuration, with strict tenant isolation proven by adversarial tests.</>,
            <><strong>Governed configuration & workflows.</strong> A configuration engine and a visual workflow builder let each facility adapt behaviour without forking the platform.</>,
            <><strong>Interoperability that respects consent.</strong> A consent-driven boundary to ABDM, FHIR R4 and SNOMED CT — architecture-aligned, honest about what needs external onboarding.</>,
            <><strong>Correct under load.</strong> Concurrency, migrations and isolation are validated on real PostgreSQL, not just in theory.</>,
          ]}
        />
      </Section>

      <Section title="How adoption works">
        <Prose>
          <p>
            Hospital and staff accounts are provisioned by your organization&rsquo;s administrator — there is
            no self-service privileged signup. We work with you to bring your facility onto the platform and
            keep it running. Start a conversation and we&rsquo;ll scope it with you.
          </p>
        </Prose>
      </Section>

      <PageCta
        title="Bring a lasting record to your hospital"
        body="Tell us about your facility and what you're trying to solve."
        actions={[
          { label: "Talk to partnerships", href: "/company/contact", primary: true },
          { label: "Hospital OS sign-in", href: "/hospital-os/login" },
        ]}
      />
    </>
  );
}
