import type { Metadata } from "next";
import {
  PageHeader, Section, Prose, CardGrid, Card, Callout, ExternalLink, PageCta,
} from "@/components/site/primitives";

export const metadata: Metadata = {
  title: "Contact | Aarogya",
  description:
    "Get in touch with Aarogya — for hospitals and partners, product and support, careers, and press. Reach the right team directly.",
  alternates: { canonical: "/company/contact" },
};

const CRUMB = [
  { label: "Home", href: "/" },
  { label: "Company", href: "/company/about" },
  { label: "Contact", href: "/company/contact" },
];

export default function ContactPage() {
  return (
    <>
      <PageHeader
        breadcrumb={CRUMB}
        eyebrow="Company · Contact"
        title="Talk to us"
        intro="Whether you run a hospital, want to partner, are looking for support, or are writing a story — here's the fastest way to reach the right people at Aarogya."
      />

      <Section title="Reach the right team" lead="Pick the channel that fits and we'll route you quickly.">
        <CardGrid>
          <Card title="Hospitals & partnerships">
            Bringing Aarogya to a hospital, lab or health system, or exploring a partnership —{" "}
            <ExternalLink href="mailto:partnerships@aarogya.ai">partnerships@aarogya.ai</ExternalLink>
          </Card>
          <Card title="Product & support">
            Questions about the platform, or help for an existing deployment —{" "}
            <ExternalLink href="mailto:support@aarogya.ai">support@aarogya.ai</ExternalLink>
          </Card>
          <Card title="Careers">
            Interested in building with us — see{" "}
            <ExternalLink href="/company/careers">open roles</ExternalLink> or email{" "}
            <ExternalLink href="mailto:careers@aarogya.ai">careers@aarogya.ai</ExternalLink>
          </Card>
          <Card title="Press & media">
            Interviews, briefings and fact-checks —{" "}
            <ExternalLink href="mailto:press@aarogya.ai">press@aarogya.ai</ExternalLink> (see the{" "}
            <ExternalLink href="/company/press">press page</ExternalLink>)
          </Card>
        </CardGrid>
      </Section>

      <Section title="General enquiries">
        <Callout title="Not sure who to ask?">
          <p>
            Email <ExternalLink href="mailto:hello@aarogya.ai">hello@aarogya.ai</ExternalLink> and we&rsquo;ll
            make sure it reaches the right person. For anything involving patient data or a security concern,
            please say so in the subject line so we can prioritise it.
          </p>
        </Callout>
      </Section>

      <Section title="Company">
        <Prose>
          <p>
            Aarogya is a product of <strong>Aparix Ventures</strong>. Built in India, for India, and beyond.
          </p>
        </Prose>
      </Section>

      <PageCta
        title="Bring a lasting health record to your hospital"
        body="Tell us about your facility and what you're trying to solve. We'll take it from there."
        actions={[
          { label: "Email partnerships@aarogya.ai", href: "mailto:partnerships@aarogya.ai", primary: true },
          { label: "About Aarogya", href: "/company/about" },
        ]}
      />
    </>
  );
}
