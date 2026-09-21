import type { Metadata } from "next";
import {
  PageHeader, Section, Prose, CardGrid, Card, StatusMatrix, Callout, BulletList, ExternalLink, PageCta,
} from "@/components/site/primitives";

export const metadata: Metadata = {
  title: "SNOMED CT — Clinical Terminology | Aarogya",
  description:
    "How Aarogya uses a clinical terminology mapping layer aligned with SNOMED CT: Aarogya ships the mapping boundary, not the licensed terminology content, and states clearly what is implemented versus what depends on an SNOMED International member licence.",
  alternates: { canonical: "/standards/snomed" },
};

const CRUMB = [
  { label: "Home", href: "/" },
  { label: "Standards", href: "/standards/abdm" },
  { label: "SNOMED CT", href: "/standards/snomed" },
];

export default function SnomedPage() {
  return (
    <>
      <PageHeader
        breadcrumb={CRUMB}
        eyebrow="Standards · Terminology"
        title="SNOMED CT"
        intro="SNOMED CT is the most comprehensive clinical terminology in the world — a way to record what a clinician means in a form a computer can reason about. Aarogya is built around a terminology mapping boundary aligned with SNOMED CT, and this page states precisely what ships in the codebase versus what depends on a licensed terminology distribution."
      />

      <Section title="What SNOMED CT is" lead="A shared clinical vocabulary, not a database of records.">
        <Prose>
          <p>
            <strong>SNOMED CT</strong> (Systematized Nomenclature of Medicine — Clinical Terms) is a
            structured collection of clinical concepts — findings, disorders, procedures, body structures,
            organisms and more — each with a unique concept identifier and defined relationships to other
            concepts. It lets &ldquo;heart attack&rdquo;, &ldquo;MI&rdquo; and &ldquo;myocardial infarction&rdquo;
            all resolve to the <em>same</em> machine-readable meaning.
          </p>
          <p>
            It is maintained by <strong>SNOMED International</strong>, and India is a member nation, which
            makes SNOMED CT the natural clinical terminology for a connected Indian health record. In FHIR,
            SNOMED CT is one of the primary code systems a coded element points at.
          </p>
        </Prose>
      </Section>

      <Section title="Why it matters" lead="Free text does not add up; coded meaning does.">
        <Prose>
          <p>
            Two hospitals can both be &ldquo;right&rdquo; and still be unable to combine their records if one
            writes &ldquo;CKD&rdquo; and the other &ldquo;chronic kidney disease&rdquo;. Coded terminology is
            what lets a longitudinal record be searched, de-duplicated, trended and safely exchanged.
            Without it, interoperability degrades into shipping paragraphs of text that no downstream system
            can act on with confidence.
          </p>
        </Prose>
      </Section>

      <Section title="How Aarogya relates to SNOMED CT" lead="Aarogya ships the mapping LAYER, and treats the terminology as an external, licensed resource.">
        <Prose>
          <p>
            Aarogya&rsquo;s interoperability design keeps its own canonical clinical record and maps to
            external code systems at a clean boundary — the same principle it applies to FHIR and ABDM. A
            dedicated <strong>terminology mapping layer</strong> separates Aarogya-local codes from external
            code systems such as SNOMED CT and LOINC, so a local concept can carry an external code when one
            is mapped.
          </p>
          <p>
            Crucially, that layer is <strong>the mechanism, not the content</strong>. Aarogya does not bundle
            the SNOMED CT distribution itself — that is a licensed dataset governed by SNOMED International
            and the national release centre. When a concept has no mapping, Aarogya exports it{" "}
            <strong>honestly as text</strong> rather than inventing a code that would be clinically unsafe.
          </p>
        </Prose>
      </Section>

      <Section title="What Aarogya actually supports" lead="Implemented in the codebase today, with maturity stated plainly.">
        <StatusMatrix
          rows={[
            { capability: "Terminology mapping layer", detail: "A first-class mapping model separates Aarogya-local codes from external code systems (SNOMED CT, LOINC, …), with create / resolve / retire and per-facility scoping.", tone: "implemented", label: "Implemented" },
            { capability: "Honest unmapped behaviour", detail: "A concept with no mapping is represented as text on export — never a fabricated or guessed code.", tone: "implemented", label: "Implemented" },
            { capability: "FHIR-ready coded elements", detail: "Mapped concepts can be emitted as coded elements pointing at the correct external code system for FHIR R4 exchange.", tone: "implemented", label: "Implemented" },
            { capability: "SNOMED CT content distribution", detail: "The SNOMED CT release itself is a licensed dataset. Loading it requires an SNOMED International member / affiliate licence and the national release, which are external to this repository.", tone: "blocked", label: "Licence-gated" },
            { capability: "Curated Indian value sets", detail: "Broad, clinically-reviewed SNOMED CT value sets for common Indian workflows are ongoing work layered on top of the mapping boundary.", tone: "planned", label: "Future work" },
          ]}
        />
      </Section>

      <Section title="Implemented / licensed / future" lead="The states we hold ourselves to.">
        <CardGrid>
          <Card title="Implemented">
            The terminology mapping layer, its honest unmapped-as-text behaviour, and the ability to emit
            mapped concepts as coded FHIR elements exist and are covered by tests.
          </Card>
          <Card title="Licence-gated">
            The SNOMED CT terminology content is distributed under an SNOMED International licence via the
            national release centre. Aarogya provides the boundary to consume it; it does not redistribute
            the dataset.
          </Card>
          <Card title="Future work">
            Growing a curated set of reviewed SNOMED CT value sets and default mappings for common Indian
            clinical workflows, on top of the existing mapping layer.
          </Card>
        </CardGrid>
      </Section>

      <Section title="What we do not claim">
        <Callout title="Precise language">
          <p>
            Aarogya is <strong>architecturally aligned with SNOMED CT</strong> through a real terminology
            mapping layer. It does <strong>not</strong> redistribute the SNOMED CT dataset, and it does{" "}
            <strong>not</strong> claim &ldquo;SNOMED CT certified&rdquo;. Using SNOMED CT content in a
            deployment requires the appropriate SNOMED International / national release licence.
          </p>
        </Callout>
      </Section>

      <Section title="Official resources">
        <BulletList
          items={[
            <>SNOMED International — <ExternalLink href="https://www.snomed.org/">snomed.org</ExternalLink></>,
            <>SNOMED CT browser — <ExternalLink href="https://browser.ihtsdotools.org/">browser.ihtsdotools.org</ExternalLink></>,
            <>HL7 FHIR R4 terminology — <ExternalLink href="https://hl7.org/fhir/R4/terminologies.html">hl7.org/fhir/R4/terminologies</ExternalLink></>,
          ]}
        />
      </Section>

      <PageCta
        title="Meaning that travels with the record"
        body="Coded terminology is what makes a longitudinal record more than a pile of documents. See the standards Aarogya builds on."
        actions={[
          { label: "FHIR R4 at Aarogya", href: "/standards/fhir", primary: true },
          { label: "ABDM alignment", href: "/standards/abdm" },
        ]}
      />
    </>
  );
}
