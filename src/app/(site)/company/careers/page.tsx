import type { Metadata } from "next";
import {
  PageHeader, Section, Prose, CardGrid, Card, Callout, BulletList, ExternalLink, PageCta,
} from "@/components/site/primitives";

export const metadata: Metadata = {
  title: "Careers | Aarogya",
  description:
    "Help build India's unified health record. Aarogya is hiring across product engineering, platform, clinical informatics, security and operations — a small, senior team that builds health infrastructure properly.",
  alternates: { canonical: "/company/careers" },
};

const CRUMB = [
  { label: "Home", href: "/" },
  { label: "Company", href: "/company/about" },
  { label: "Careers", href: "/company/careers" },
];

export default function CareersPage() {
  return (
    <>
      <PageHeader
        breadcrumb={CRUMB}
        eyebrow="Company · Careers"
        title="Build health infrastructure that lasts"
        intro="Aarogya is a small, senior team building the record layer for Indian healthcare. The work is hard in the ways that matter — correctness, safety, consent and scale — and we do it with unusual discipline. If that appeals to you, we would like to talk."
      />

      <Section title="How we work" lead="A few things that are true of every role here.">
        <BulletList
          items={[
            <><strong>Ownership, end to end.</strong> You own a problem from schema to UI to the test that proves it works on a real database.</>,
            <><strong>Correctness is the job.</strong> This is healthcare. We write adversarial tests, we reason about concurrency, and we do not ship enforcement theatre.</>,
            <><strong>Honesty is a feature.</strong> We say what is real, sandbox-ready, or externally blocked — internally and to customers.</>,
            <><strong>Small team, high leverage.</strong> Few people, senior scope, short path from idea to production.</>,
          ]}
        />
      </Section>

      <Section title="Where we are hiring" lead="Disciplines we are actively growing.">
        <CardGrid>
          <Card title="Product Engineering">
            Full-stack engineers (TypeScript, Next.js, Prisma/Postgres) who can own a clinical or patient
            workflow from data model to interface.
          </Card>
          <Card title="Platform & Infrastructure">
            Engineers who care about multi-tenancy, migrations, concurrency, event architecture and keeping a
            large monolith fast and correct.
          </Card>
          <Card title="Clinical Informatics">
            Clinicians and informaticians who can translate real hospital workflows into safe, coded,
            interoperable models (FHIR, SNOMED CT, ABDM).
          </Card>
          <Card title="Security & Privacy">
            People who think in threat models — authorization, IDOR, consent, DPDP-aligned data protection —
            and prove their work with tests, not slides.
          </Card>
          <Card title="Design & Frontend">
            Designers and frontend engineers who can make a dense clinical system feel calm, and a patient
            portal feel human.
          </Card>
          <Card title="Operations & Delivery">
            Implementation and customer engineers who can take Aarogya into a live hospital and make it stick.
          </Card>
        </CardGrid>
      </Section>

      <Section title="How to apply">
        <Callout title="Send us something real">
          <p>
            We don&rsquo;t have a heavy application funnel. Email{" "}
            <ExternalLink href="mailto:careers@aarogya.ai">careers@aarogya.ai</ExternalLink> with the
            discipline you&rsquo;re interested in, a short note on something you&rsquo;ve built or shipped, and
            anything that shows how you think — a repo, a write-up, a design. We read every one.
          </p>
        </Callout>
        <Prose>
          <p>
            Don&rsquo;t see your exact role? Write anyway. Good people create their own roles here more often
            than they fill listed ones.
          </p>
        </Prose>
      </Section>

      <PageCta
        title="Come build the record that never forgets"
        body="Tell us what you want to build and why healthcare. We'll take it from there."
        actions={[
          { label: "Email careers@aarogya.ai", href: "mailto:careers@aarogya.ai", primary: true },
          { label: "About Aarogya", href: "/company/about" },
        ]}
      />
    </>
  );
}
