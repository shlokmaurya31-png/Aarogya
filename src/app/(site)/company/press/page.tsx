import type { Metadata } from "next";
import {
  PageHeader, Section, Prose, CardGrid, Card, Callout, BulletList, ExternalLink, PageCta,
} from "@/components/site/primitives";

export const metadata: Metadata = {
  title: "Press | Aarogya",
  description:
    "Press and media resources for Aarogya — company boilerplate, key facts, brand basics and press contact. Aarogya is India's unified health intelligence platform, a product of Aparix Ventures.",
  alternates: { canonical: "/company/press" },
};

const CRUMB = [
  { label: "Home", href: "/" },
  { label: "Company", href: "/company/about" },
  { label: "Press", href: "/company/press" },
];

export default function PressPage() {
  return (
    <>
      <PageHeader
        breadcrumb={CRUMB}
        eyebrow="Company · Press"
        title="Press & media"
        intro="Resources for journalists and partners writing about Aarogya. For interviews, briefings, or anything not covered here, reach our press team directly."
      />

      <Section title="Company boilerplate" lead="Approved language you can quote.">
        <Callout title="About Aarogya">
          <p>
            Aarogya is India&rsquo;s unified health intelligence platform — one longitudinal health record,
            every hospital, for life. It combines a complete hospital operating system with a secure,
            patient-controlled experience layer, connected to India&rsquo;s digital health ecosystem through a
            consent-driven interoperability boundary (ABDM, FHIR R4, SNOMED CT). Aarogya is a product of
            Aparix Ventures and is built in India, for India, and beyond.
          </p>
        </Callout>
      </Section>

      <Section title="Key facts" lead="At a glance.">
        <CardGrid>
          <Card title="What it is">
            A unified health platform: hospital operating system + patient experience + consent-driven
            interoperability, on one canonical record.
          </Card>
          <Card title="Who makes it">
            Aparix Ventures — a senior team of engineers, clinicians and operators building health
            infrastructure for India.
          </Card>
          <Card title="How it is built">
            Consent-first and patient-controlled, in disciplined phases closed against correctness and
            security gates on real databases.
          </Card>
          <Card title="Where it stands on standards">
            Architecture-aligned with ABDM, FHIR R4 and SNOMED CT; honest about what is implemented,
            sandbox-ready, or externally blocked.
          </Card>
        </CardGrid>
      </Section>

      <Section title="Using the Aarogya name & brand">
        <BulletList
          items={[
            <>Write the name as <strong>Aarogya</strong> (or <strong>Aarogya AI</strong>). Please don&rsquo;t alter, recolour or reconstruct the logo.</>,
            <>Describe the company as <strong>&ldquo;Aarogya, a product of Aparix Ventures&rdquo;</strong> on first mention.</>,
            <>For logo files, fact-checking a claim, or an accurate description of capabilities and their maturity, contact the press team below before publishing.</>,
          ]}
        />
      </Section>

      <Section title="Responsible reporting on health claims">
        <Prose>
          <p>
            We ask one thing of anyone writing about Aarogya: reflect capability maturity accurately. Aarogya
            is <strong>architecture-aligned</strong> with the standards it names and is honest about what
            requires external onboarding or certification. We are glad to help you state it precisely.
          </p>
        </Prose>
      </Section>

      <Section title="Press contact">
        <Callout title="Media enquiries">
          <p>
            Email <ExternalLink href="mailto:press@aarogya.ai">press@aarogya.ai</ExternalLink> with your
            outlet, deadline and what you need. We respond quickly to journalists on deadline.
          </p>
        </Callout>
      </Section>

      <PageCta
        title="Writing about Indian digital health?"
        body="We're happy to brief you accurately on the platform, the standards, and where the field is going."
        actions={[
          { label: "Email press@aarogya.ai", href: "mailto:press@aarogya.ai", primary: true },
          { label: "About Aarogya", href: "/company/about" },
        ]}
      />
    </>
  );
}
