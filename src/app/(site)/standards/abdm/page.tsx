import type { Metadata } from "next";
import {
  PageHeader, Section, Prose, CardGrid, Card, StatusMatrix, Callout, BulletList, ExternalLink, PageCta,
} from "@/components/site/primitives";

export const metadata: Metadata = {
  title: "ABDM — Ayushman Bharat Digital Mission | Aarogya",
  description:
    "How Aarogya's architecture aligns with India's Ayushman Bharat Digital Mission (ABDM): consent-driven health information exchange, FHIR R4, and a clearly-scoped implemented / sandbox / externally-blocked status.",
  alternates: { canonical: "/standards/abdm" },
};

const CRUMB = [
  { label: "Home", href: "/" },
  { label: "Standards", href: "/standards/abdm" },
  { label: "ABDM", href: "/standards/abdm" },
];

export default function AbdmPage() {
  return (
    <>
      <PageHeader
        breadcrumb={CRUMB}
        eyebrow="Standards · Interoperability"
        title="Ayushman Bharat Digital Mission"
        intro="ABDM is the national framework for India's connected digital health ecosystem — a consent-driven way for a patient's records to move between the providers who care for them. Aarogya is built to participate in that ecosystem, and this page states precisely what is implemented, what is sandbox-ready, and what depends on external onboarding."
      />

      <Section title="What ABDM is" lead="A public digital backbone for health, not a single application.">
        <Prose>
          <p>
            The <strong>Ayushman Bharat Digital Mission</strong>, led by the National Health Authority,
            defines the identifiers, registries and exchange protocols that let health data flow safely
            across India — health IDs for patients, registries for facilities and professionals, and a
            <strong> consent-driven</strong> mechanism for sharing clinical records between systems.
          </p>
          <p>
            Its premise is that a patient owns their health information and that any exchange happens only
            with an explicit, revocable consent artefact. Interoperability is expressed largely through
            <strong> HL7 FHIR R4</strong> resources exchanged under ABDM profiles.
          </p>
        </Prose>
      </Section>

      <Section title="Why it matters" lead="Fragmented records are a patient-safety problem.">
        <Prose>
          <p>
            Most Indian patients carry their history on paper across unconnected hospitals, labs and
            pharmacies. A clinician making a decision without the prior record is a clinician making a
            decision with a blind spot. ABDM is the shared language that lets a record travel with the
            patient — which is the same problem Aarogya exists to solve.
          </p>
        </Prose>
      </Section>

      <Section title="How Aarogya relates to ABDM" lead="Aarogya keeps its own canonical clinical record and maps to ABDM at a clean boundary.">
        <Prose>
          <p>
            Aarogya&rsquo;s interoperability layer (built across Phase C of the platform) treats an external
            standard as a <strong>boundary</strong>, never as the internal data model. Aarogya owns its
            canonical clinical record; a dedicated adapter maps that record to and from ABDM FHIR resources,
            gated by consent and recorded in an audit trail. An unmapped concept is exported honestly as
            text rather than acquiring a fabricated code.
          </p>
        </Prose>
      </Section>

      <Section title="What Aarogya actually supports" lead="Implemented in the codebase today, with maturity stated plainly.">
        <StatusMatrix
          rows={[
            { capability: "FHIR R4 representation", detail: "Canonical domain → FHIR R4 mappers for core clinical resources, with a profile-validation boundary for ABDM profiles.", tone: "implemented", label: "Implemented" },
            { capability: "Consent-driven exchange", detail: "A consent artefact and exchange state machine gate every outbound share; nothing is exchanged without an active consent.", tone: "implemented", label: "Implemented" },
            { capability: "Terminology mapping layer", detail: "A mapping layer separates Aarogya-local codes from external code systems; unmapped concepts export as text.", tone: "implemented", label: "Implemented" },
            { capability: "ABDM adapter + callback ledger", detail: "An adapter, contract matrix and callback ledger model the ABDM protocol, including out-of-order and replayed callbacks.", tone: "implemented", label: "Implemented" },
            { capability: "Sandbox connectivity", detail: "Sandbox setup and verification are documented and the contract is exercised against the sandbox contract shape.", tone: "sandbox", label: "Sandbox-ready" },
            { capability: "Production connectivity", detail: "Live ABDM exchange requires National Health Authority onboarding and issued credentials, which are an external dependency.", tone: "blocked", label: "Externally blocked" },
          ]}
        />
      </Section>

      <Section title="Implemented / sandbox / blocked / future" lead="The four states we hold ourselves to.">
        <CardGrid>
          <Card title="Implemented">
            FHIR R4 mapping, the consent + exchange state machine, the terminology boundary, and the ABDM
            adapter with its callback/protocol handling exist and are covered by tests.
          </Card>
          <Card title="Sandbox-ready">
            The ABDM contract is documented as a contract matrix with sandbox setup and verification notes,
            so the integration can be exercised against the sandbox environment&rsquo;s expected shapes.
          </Card>
          <Card title="Externally blocked">
            Production ABDM connectivity needs NHA onboarding and issued gateway credentials. Those are not
            present in this repository, so Aarogya does not claim live production ABDM exchange.
          </Card>
          <Card title="Future work">
            Completing production go-live once onboarding and credentials are in place, and broadening the
            set of FHIR profiles and terminology mappings covered.
          </Card>
        </CardGrid>
      </Section>

      <Section title="What we do not claim">
        <Callout title="Precise language">
          <p>
            Aarogya is <strong>architecture-aligned with ABDM</strong> and <strong>sandbox-ready</strong>. It
            is <strong>not</strong> &ldquo;ABDM certified&rdquo; and does <strong>not</strong> have live
            production ABDM connectivity in this repository. Any such claim would require NHA onboarding,
            issued credentials and formal certification that are external to this codebase.
          </p>
        </Callout>
      </Section>

      <Section title="Official resources">
        <BulletList
          items={[
            <>National Health Authority — <ExternalLink href="https://abdm.gov.in/">abdm.gov.in</ExternalLink></>,
            <>ABDM sandbox &amp; developer documentation — <ExternalLink href="https://sandbox.abdm.gov.in/">sandbox.abdm.gov.in</ExternalLink></>,
            <>HL7 FHIR R4 — <ExternalLink href="https://hl7.org/fhir/R4/">hl7.org/fhir/R4</ExternalLink></>,
          ]}
        />
      </Section>

      <PageCta
        title="Interoperability that respects consent"
        body="See how Aarogya models health information exchange, or explore the related standards it aligns with."
        actions={[
          { label: "FHIR R4 at Aarogya", href: "/standards/fhir", primary: true },
          { label: "ABHA identity", href: "/standards/abha" },
        ]}
      />
    </>
  );
}
