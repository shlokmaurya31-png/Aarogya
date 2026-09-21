import type { Metadata } from "next";
import {
  PageHeader, Section, Prose, CardGrid, Card, BulletList, Callout, PageCta,
} from "@/components/site/primitives";

export const metadata: Metadata = {
  title: "For Insurers & Payers | Aarogya",
  description:
    "Cleaner claims from a cleaner record. Aarogya connects coverage, pre-authorization and claims to the actual clinical and billing source, with an NHCX exchange boundary built for consent and provenance.",
  alternates: { canonical: "/platform/insurers" },
};

const CRUMB = [
  { label: "Home", href: "/" },
  { label: "Platform", href: "/platform/patients" },
  { label: "Insurers", href: "/platform/insurers" },
];

export default function InsurersPage() {
  return (
    <>
      <PageHeader
        breadcrumb={CRUMB}
        eyebrow="Platform · Insurers & Payers"
        title="Cleaner claims, from a cleaner record"
        intro="Most claim friction is really record friction — amounts and codes that don't trace back to anything. Aarogya links coverage, pre-authorization and claims to the actual clinical and billing source, so what's submitted is what happened."
      />

      <Section title="Coverage to claim, connected" lead="Every claim traces back to a real charge and a real order.">
        <CardGrid>
          <Card title="Coverage & pre-auth">Patient coverage, payers and plans, and pre-authorization tracked against the encounter that needs it.</Card>
          <Card title="Claims on real charges">Claims are built from invoice lines that trace to charges that trace to the originating clinical order — a complete provenance chain.</Card>
          <Card title="NHCX exchange">A dedicated protocol boundary for health-claims exchange, kept separate from claim status so &ldquo;not sent&rdquo; never looks like &ldquo;not answered&rdquo;.</Card>
          <Card title="Reconciliation">Settlements and exceptions are reconciled against submitted claims, so mismatches surface instead of hiding.</Card>
        </CardGrid>
      </Section>

      <Section title="Built for trust" lead="Consent and provenance are structural, not optional.">
        <BulletList
          items={[
            <><strong>Consent-driven exchange.</strong> Health information moves only under an explicit, auditable consent — the patient is never bypassed.</>,
            <><strong>Server-computed amounts.</strong> Financial figures are computed from the canonical record, never asserted by a client.</>,
            <><strong>No fabricated approvals.</strong> Claim and authorization statuses reflect a real payer decision — Aarogya never invents one.</>,
          ]}
        />
      </Section>

      <Section title="Where this stands today">
        <Callout title="Honest about integration maturity">
          <p>
            Aarogya models the claims and NHCX exchange boundary and is architecture-aligned with the national
            protocols. Live payer/NHCX connectivity depends on onboarding and issued credentials that sit
            outside this platform — we&rsquo;ll always tell you plainly what is live versus sandbox.
          </p>
        </Callout>
      </Section>

      <PageCta
        title="Let's reduce claim friction together"
        body="Talk to us about connecting your claims and exchange workflows to a record that traces."
        actions={[
          { label: "Talk to partnerships", href: "/company/contact", primary: true },
          { label: "NHCX & claims exchange", href: "/standards/abdm" },
        ]}
      />
    </>
  );
}
