import type { Metadata } from "next";
import {
  PageHeader, Section, Prose, CardGrid, Card, Callout, BulletList, PageCta,
} from "@/components/site/primitives";

export const metadata: Metadata = {
  title: "About | Aarogya",
  description:
    "Aarogya is India's unified health intelligence platform — one longitudinal record, every hospital, for life. Built consent-first, patient-controlled, and honest about what is real.",
  alternates: { canonical: "/company/about" },
};

const CRUMB = [
  { label: "Home", href: "/" },
  { label: "Company", href: "/company/about" },
  { label: "About", href: "/company/about" },
];

export default function AboutPage() {
  return (
    <>
      <PageHeader
        breadcrumb={CRUMB}
        eyebrow="Company"
        title="One record, every hospital, for life"
        intro="Aarogya exists to give every Indian a single, trustworthy health record that travels with them — and to give the clinicians who care for them a decision made with the full picture, not a blind spot. We build it consent-first, patient-controlled, and honest about exactly what is real today."
      />

      <Section title="Why we exist" lead="A record that forgets is a patient-safety problem.">
        <Prose>
          <p>
            Most people in India carry their medical history on paper, across hospitals, labs and pharmacies
            that cannot talk to each other. Every gap is a repeated test, a missed allergy, a slower
            diagnosis. Aarogya turns that fragmented paper trail into <strong>one longitudinal record</strong> —
            owned by the patient, readable by the people they authorise, and built to move safely between
            the systems that care for them.
          </p>
        </Prose>
      </Section>

      <Section title="What we are building" lead="A full hospital operating system with a patient at the centre of it.">
        <CardGrid>
          <Card title="Hospital OS">
            A complete clinical and operational platform — encounters, orders, diagnostics, pharmacy, beds,
            billing and a real-time command centre — running one canonical record.
          </Card>
          <Card title="Patient Experience">
            A secure, patient-controlled window onto that record: appointments, reports, prescriptions, bills,
            consent and family access, with the patient authorising every action that belongs to them.
          </Card>
          <Card title="Interoperability">
            A consent-driven boundary to India's digital health ecosystem — ABDM, FHIR R4, SNOMED CT — so a
            record can travel without ever being copied into a second source of truth.
          </Card>
          <Card title="Commercial platform">
            A multi-hospital SaaS foundation — tenancy, entitlements, billing and configuration — so the
            platform can serve many facilities without compromising isolation.
          </Card>
        </CardGrid>
      </Section>

      <Section title="What we believe" lead="The principles the code is held to, not just the marketing.">
        <BulletList
          items={[
            <><strong>The patient owns their record.</strong> Access is consent-driven and revocable; a record is never shared without an explicit, auditable reason.</>,
            <><strong>One source of truth.</strong> Every clinical and financial fact lives in one canonical place. Nothing downstream is allowed to quietly become a second, drifting copy.</>,
            <><strong>Honesty over theatre.</strong> We state plainly what is implemented, what is sandbox-ready, and what depends on external onboarding. We never fake a successful integration.</>,
            <><strong>Safe by construction.</strong> Authorisation, tenant isolation and audit are boundaries, not afterthoughts — proven with adversarial tests on real databases.</>,
          ]}
        />
      </Section>

      <Section title="How we build">
        <Callout title="Architecture before enforcement, never enforcement theatre">
          <p>
            Aarogya is built in disciplined phases, each closed only when it passes correctness and security
            gates on both SQLite and PostgreSQL, with zero schema drift and no weakened tests. The result is a
            platform whose claims you can check in the codebase — the same standard we ask of any health
            system that touches a patient&rsquo;s life.
          </p>
        </Callout>
      </Section>

      <Section title="Who we are">
        <Prose>
          <p>
            Aarogya is a product of <strong>Aparix Ventures</strong> — a small, senior team building health
            infrastructure in India, for India, and beyond. We are engineers, clinicians and operators who
            think a country&rsquo;s health record is worth building properly.
          </p>
        </Prose>
      </Section>

      <PageCta
        title="Build the memory Indian healthcare deserves"
        body="We are hiring across engineering, clinical informatics and operations. If a health record that never forgets sounds like your kind of problem, talk to us."
        actions={[
          { label: "See open roles", href: "/company/careers", primary: true },
          { label: "Contact us", href: "/company/contact" },
        ]}
      />
    </>
  );
}
