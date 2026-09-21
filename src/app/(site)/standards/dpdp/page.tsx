import type { Metadata } from "next";
import {
  PageHeader, Section, Prose, CardGrid, Card, StatusMatrix, Callout, BulletList, ExternalLink, PageCta,
} from "@/components/site/primitives";

export const metadata: Metadata = {
  title: "Healthcare privacy & the DPDP Act 2023 | Aarogya",
  description:
    "How Aarogya is designed with privacy controls that support responsible handling of personal data — authorization, consent, purpose limitation, break-glass, auditability and session revocation — with clear, non-legal language.",
  alternates: { canonical: "/standards/dpdp" },
};

const CRUMB = [
  { label: "Home", href: "/" },
  { label: "Standards", href: "/standards/abdm" },
  { label: "DPDP Act 2023", href: "/standards/dpdp" },
];

export default function DpdpPage() {
  return (
    <>
      <PageHeader
        breadcrumb={CRUMB}
        eyebrow="Standards · Privacy & Governance"
        title="Healthcare privacy & the DPDP Act 2023"
        intro="Health data is among the most sensitive personal data there is. Aarogya is designed with privacy controls that support responsible handling of personal data — access control, consent, purpose limitation, auditability and revocation. This page explains those controls in plain terms; it is not legal advice and makes no claim of certification."
      />

      <Section title="Why healthcare data needs strong privacy" lead="The stakes are higher than in almost any other domain.">
        <Prose>
          <p>
            India&rsquo;s <strong>Digital Personal Data Protection Act, 2023</strong> sets expectations for how
            personal data is collected, used and protected — including consent, purpose limitation and the
            rights of the individual. In healthcare those expectations are not abstract: a leaked diagnosis or a
            record opened without a reason is a direct harm to a real person.
          </p>
          <p>
            Aarogya&rsquo;s security model treats access to a record as something that must be <strong>justified,
            scoped and recorded</strong> — never assumed because someone happens to be logged in.
          </p>
        </Prose>
      </Section>

      <Section title="How Aarogya's architecture supports these principles" lead="The Phase C4 trust layer, applied on every sensitive action.">
        <Prose>
          <p>
            Aarogya&rsquo;s authorization is separate from, and additional to, simply being authenticated. A
            request must satisfy a real access decision — the right role, the right tenant, a legitimate purpose
            and, for the most sensitive data, an established relationship to the patient. Emergency access is
            possible, but only through a deliberate, logged <strong>break-glass</strong> path, never as a silent
            bypass.
          </p>
        </Prose>
        <div className="mt-6">
          <StatusMatrix
            rows={[
              { capability: "Access control", detail: "A dedicated authorization engine evaluates role, tenant scope, purpose and relationship on sensitive actions — beyond authentication alone.", tone: "implemented", label: "Implemented" },
              { capability: "Consent", detail: "Health information exchange is gated by consent artefacts; nothing is shared externally without an active consent.", tone: "implemented", label: "Implemented" },
              { capability: "Purpose limitation", detail: "Access decisions carry a stated purpose, so access is tied to why it is needed, not just who is asking.", tone: "implemented", label: "Implemented" },
              { capability: "Break-glass", detail: "Emergency access uses an explicit, time-boxed and fully audited break-glass path rather than a silent override.", tone: "implemented", label: "Implemented" },
              { capability: "Auditability", detail: "Sensitive actions — including denials and break-glass — are recorded to a structured audit trail.", tone: "implemented", label: "Implemented" },
              { capability: "Session revocation", detail: "Sessions can be revoked immediately (per user or all sessions), so a role change or logout takes effect at once.", tone: "implemented", label: "Implemented" },
              { capability: "Privacy classification", detail: "Records carry sensitivity classification so more sensitive data attracts stricter access checks.", tone: "implemented", label: "Implemented" },
            ]}
          />
        </div>
      </Section>

      <Section title="Controls in practice">
        <CardGrid cols={3}>
          <Card title="Least privilege">
            Roles are scoped to what a person needs. Commercial and administrative powers are separated from
            clinical ones, and neither implies the other.
          </Card>
          <Card title="Accountability">
            Access — and refusal of access — leaves a trail. Break-glass makes emergency access possible while
            keeping it visible after the fact.
          </Card>
          <Card title="Revocability">
            Consent can be revoked, and sessions can be terminated immediately, so access does not outlive the
            reason for it.
          </Card>
        </CardGrid>
      </Section>

      <Section title="What we do not claim">
        <Callout title="Precise language, and not legal advice">
          <p>
            Aarogya is <strong>designed with privacy controls that support responsible handling of personal
            data</strong>. This page describes engineering controls; it is <strong>not legal advice</strong> and
            is <strong>not</strong> a claim of DPDP certification, guaranteed compliance or regulatory approval.
            Compliance depends on how an organisation configures, operates and governs the platform, alongside
            its own legal assessment.
          </p>
        </Callout>
      </Section>

      <Section title="Official resources">
        <BulletList
          items={[
            <>Digital Personal Data Protection Act, 2023 (official gazette / MeitY) — <ExternalLink href="https://www.meity.gov.in/data-protection-framework">meity.gov.in</ExternalLink></>,
          ]}
        />
      </Section>

      <PageCta
        title="Privacy as an engineering property"
        body="See the identity and interoperability standards these controls protect."
        actions={[
          { label: "ABHA identity", href: "/standards/abha", primary: true },
          { label: "ABDM exchange", href: "/standards/abdm" },
        ]}
      />
    </>
  );
}
