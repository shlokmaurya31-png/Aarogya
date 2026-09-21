import type { Metadata } from "next";
import {
  PageHeader, Section, Prose, CardGrid, Card, StatusMatrix, Callout, BulletList, ExternalLink, PageCta,
} from "@/components/site/primitives";

export const metadata: Metadata = {
  title: "FHIR R4 — structured, interoperable health data | Aarogya",
  description:
    "How Aarogya represents its canonical clinical record as HL7 FHIR R4 resources, with a profile-validation boundary — and exactly what has and has not been validated at the profile-conformance level.",
  alternates: { canonical: "/standards/fhir" },
};

const CRUMB = [
  { label: "Home", href: "/" },
  { label: "Standards", href: "/standards/abdm" },
  { label: "FHIR R4", href: "/standards/fhir" },
];

export default function FhirPage() {
  return (
    <>
      <PageHeader
        breadcrumb={CRUMB}
        eyebrow="Standards · Data model"
        title="HL7 FHIR R4"
        intro="FHIR R4 is the modern standard for representing and exchanging healthcare data as structured resources. Aarogya keeps its own canonical clinical record and maps it to FHIR R4 at a clean boundary, so data can be exchanged in a form other systems understand — with an honest account of what has been validated."
      />

      <Section title="What FHIR is" lead="Healthcare data as well-defined, structured resources.">
        <Prose>
          <p>
            <strong>FHIR (Fast Healthcare Interoperability Resources)</strong>, from HL7, models clinical
            information as discrete <strong>resources</strong> — Patient, Encounter, Condition, Observation,
            AllergyIntolerance, MedicationRequest and more — each with a defined structure and vocabulary.
            <strong> R4</strong> is the widely-adopted normative release used across national programmes,
            including India&rsquo;s ABDM.
          </p>
          <p>
            Structured resources are what make data <strong>interoperable</strong> rather than merely
            transferable: a receiving system can reason about a lab result or a diagnosis because its shape and
            meaning are standardised.
          </p>
        </Prose>
      </Section>

      <Section title="Why structured data matters" lead="Text moves; meaning is what has to survive the move.">
        <Prose>
          <p>
            A PDF can be emailed anywhere and understood by no machine. FHIR carries not just the value but its
            meaning — units, status, coding system, references between resources — so an allergy stays an
            allergy and a critical result stays flagged as it crosses a system boundary. That is the difference
            between exchanging documents and exchanging a usable record.
          </p>
        </Prose>
      </Section>

      <Section title="How Aarogya implements FHIR R4" lead="A canonical record, mapped to FHIR at the edge.">
        <Prose>
          <p>
            Aarogya&rsquo;s internal model is its own canonical clinical core. A dedicated mapping layer converts
            those records to FHIR R4 resources for export and exchange, and a <strong>profile-validation
            boundary</strong> checks resources against the profiles an exchange requires. Where a local concept
            has no external code mapping, the resource carries <strong>text only</strong> rather than an invented
            code — honest data beats fabricated conformance.
          </p>
        </Prose>
        <div className="mt-6">
          <StatusMatrix
            rows={[
              { capability: "Domain → FHIR R4 mappers", detail: "Core clinical resources (e.g. Patient, Encounter, Condition, Observation) are mapped from the canonical record, with mapper tests.", tone: "implemented", label: "Implemented" },
              { capability: "Profile-validation boundary", detail: "A registry and validation step check outbound resources against required profiles before they are exchanged.", tone: "implemented", label: "Implemented" },
              { capability: "Honest coding", detail: "Unmapped concepts export as text; codes are only emitted when a genuine terminology mapping supplies one.", tone: "implemented", label: "Implemented" },
              { capability: "Formal profile conformance testing", detail: "Conformance against published national profiles (e.g. ABDM profiles) using official validators / test suites is future work.", tone: "planned", label: "Planned" },
            ]}
          />
        </div>
      </Section>

      <Section title="What has and has not been validated">
        <CardGrid>
          <Card title="Validated">
            The mapping layer is covered by tests that assert Aarogya records map to the expected R4 shapes and
            vocabularies for the resources it supports.
          </Card>
          <Card title="Not yet validated">
            Aarogya has not run formal profile-conformance certification against published national FHIR
            profiles. Profile-level conformance is therefore stated as designed-for and planned, not proven.
          </Card>
        </CardGrid>
      </Section>

      <Section title="What we do not claim">
        <Callout title="Precise language">
          <p>
            Aarogya <strong>implements FHIR R4 mapping and validation for the resources it supports</strong>. It
            does <strong>not</strong> claim universal FHIR conformance or &ldquo;FHIR certified&rdquo; status, and
            profile-level conformance against published national profiles has not been formally validated.
          </p>
        </Callout>
      </Section>

      <Section title="Official resources">
        <BulletList
          items={[
            <>HL7 FHIR R4 specification — <ExternalLink href="https://hl7.org/fhir/R4/">hl7.org/fhir/R4</ExternalLink></>,
            <>HL7 International — <ExternalLink href="https://www.hl7.org/">hl7.org</ExternalLink></>,
          ]}
        />
      </Section>

      <PageCta
        title="Structured data, exchanged with consent"
        body="See how Aarogya uses FHIR within India's digital health ecosystem."
        actions={[
          { label: "ABDM at Aarogya", href: "/standards/abdm", primary: true },
          { label: "SNOMED CT", href: "/standards/snomed" },
        ]}
      />
    </>
  );
}
