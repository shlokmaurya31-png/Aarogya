import type { Metadata } from "next";
import {
  PageHeader, Section, Prose, CardGrid, Card, StatusMatrix, Callout, BulletList, ExternalLink, PageCta,
} from "@/components/site/primitives";

export const metadata: Metadata = {
  title: "ABHA — Ayushman Bharat Health Account | Aarogya",
  description:
    "What ABHA is, how it differs from a clinical record, and how Aarogya models external health identifiers as verifiable mappings onto its own canonical patient records — without assuming every user has an ABHA.",
  alternates: { canonical: "/standards/abha" },
};

const CRUMB = [
  { label: "Home", href: "/" },
  { label: "Standards", href: "/standards/abdm" },
  { label: "ABHA", href: "/standards/abha" },
];

export default function AbhaPage() {
  return (
    <>
      <PageHeader
        breadcrumb={CRUMB}
        eyebrow="Standards · Identity"
        title="Ayushman Bharat Health Account"
        intro="ABHA is India's standard health identity — the identifier that lets a person's records be found and linked across the ABDM ecosystem. Aarogya treats an ABHA as a verifiable identifier that maps onto a patient's canonical record, not as a replacement for the record itself."
      />

      <Section title="What ABHA is" lead="An identity, addressed to a person — not their chart.">
        <Prose>
          <p>
            An <strong>ABHA (Ayushman Bharat Health Account)</strong> is a standardised health identity issued
            within the ABDM ecosystem. It gives an individual a stable, portable way to be identified and to
            link their health records across otherwise-disconnected providers.
          </p>
          <p>
            Crucially, an ABHA is an <strong>identifier</strong>, not a medical record. It answers &ldquo;who
            is this person, verifiably?&rdquo; — the clinical content still lives in each provider&rsquo;s
            system and moves only under consent.
          </p>
        </Prose>
      </Section>

      <Section title="Identity versus clinical record" lead="Keeping the two separate is a safety property, not an accident.">
        <Prose>
          <p>
            Conflating an identifier with a record is how the wrong chart gets attached to the wrong person.
            Aarogya deliberately separates the two: the patient record is the source of truth for clinical
            content, and external identifiers such as ABHA are <strong>mappings onto</strong> that record —
            each recorded, verifiable, and independently revocable.
          </p>
        </Prose>
      </Section>

      <Section title="How Aarogya handles external identifiers" lead="A dedicated external-identifier model, with verification and conflict protection.">
        <Prose>
          <p>
            Aarogya models external identity through a dedicated <strong>external identifier</strong> structure
            that links registry identities — ABHA for patients, and the facility/professional registries for
            organisations and staff — to Aarogya&rsquo;s own records. A mapping carries its type and its
            verification state, and the system guards against silently linking one person to an identifier that
            already belongs to somebody else.
          </p>
        </Prose>
        <div className="mt-6">
          <StatusMatrix
            rows={[
              { capability: "External identifier model", detail: "A first-class structure links ABHA / registry identifiers to canonical patient, facility and staff records.", tone: "implemented", label: "Implemented" },
              { capability: "Verification state", detail: "Each linked identifier records whether it has been verified, so unverified links are never treated as proven.", tone: "implemented", label: "Implemented" },
              { capability: "Duplicate-link protection", detail: "The system refuses to silently attach an identifier that is already claimed by another record.", tone: "implemented", label: "Implemented" },
              { capability: "Live ABHA creation / verification", detail: "Creating or verifying an ABHA against ABDM in production depends on NHA onboarding and issued credentials.", tone: "blocked", label: "Externally blocked" },
            ]}
          />
        </div>
      </Section>

      <Section title="What Aarogya does and does not assume">
        <CardGrid>
          <Card title="Not everyone has an ABHA">
            Aarogya never assumes a patient already has an ABHA. Records exist independently; an ABHA is linked
            when one is genuinely present and verified, and care is never blocked on its absence.
          </Card>
          <Card title="No fabricated identifiers">
            Aarogya does not invent or display test ABHA numbers as if they were real, and does not treat an
            unverified link as verified.
          </Card>
        </CardGrid>
      </Section>

      <Section title="What we do not claim">
        <Callout title="Precise language">
          <p>
            Aarogya <strong>implements the architecture to map and verify external health identifiers</strong>
            including ABHA. Live ABHA creation and verification against ABDM in production require National
            Health Authority onboarding and credentials that are external to this codebase, so Aarogya does not
            claim live production ABHA issuance.
          </p>
        </Callout>
      </Section>

      <Section title="Official resources">
        <BulletList
          items={[
            <>ABHA — <ExternalLink href="https://abha.abdm.gov.in/">abha.abdm.gov.in</ExternalLink></>,
            <>Ayushman Bharat Digital Mission — <ExternalLink href="https://abdm.gov.in/">abdm.gov.in</ExternalLink></>,
          ]}
        />
      </Section>

      <PageCta
        title="Identity you can trust, records you control"
        body="Explore how Aarogya exchanges records under consent, and how it protects personal data."
        actions={[
          { label: "ABDM at Aarogya", href: "/standards/abdm", primary: true },
          { label: "Privacy & DPDP", href: "/standards/dpdp" },
        ]}
      />
    </>
  );
}
