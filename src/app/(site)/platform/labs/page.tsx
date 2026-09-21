import type { Metadata } from "next";
import {
  PageHeader, Section, Prose, CardGrid, Card, BulletList, PageCta,
} from "@/components/site/primitives";

export const metadata: Metadata = {
  title: "For Labs & Diagnostics | Aarogya",
  description:
    "A real diagnostics lifecycle for laboratory and radiology — orders, specimens, results, verification and release — with turnaround tracking and results that flow straight into the patient's record.",
  alternates: { canonical: "/platform/labs" },
};

const CRUMB = [
  { label: "Home", href: "/" },
  { label: "Platform", href: "/platform/patients" },
  { label: "Labs", href: "/platform/labs" },
];

export default function LabsPage() {
  return (
    <>
      <PageHeader
        breadcrumb={CRUMB}
        eyebrow="Platform · Labs & Diagnostics"
        title="From order to result, one clean lifecycle"
        intro="Diagnostics is where a lot of care quietly succeeds or fails. Aarogya models the whole lab and radiology lifecycle as real state — not a spreadsheet — so nothing is lost between the order and the result."
      />

      <Section title="The diagnostics workflow, done properly" lead="Every step is a real, trackable state.">
        <CardGrid>
          <Card title="Orders & specimens">Receive orders, track specimens through collection and accessioning, and catch rejections early.</Card>
          <Card title="Results & verification">Enter structured results, apply reference ranges, and verify before anything is released — with a full amendment trail.</Card>
          <Card title="Radiology">Imaging studies and reports with their own lifecycle, from scheduling to verified, acknowledged report.</Card>
          <Card title="Turnaround & criticals">Order-to-result turnaround is measured, and critical findings carry an explicit acknowledgement path.</Card>
        </CardGrid>
      </Section>

      <Section title="Results that actually go somewhere" lead="No re-keying, no lost reports.">
        <BulletList
          items={[
            <><strong>Straight into the record.</strong> A verified result flows into the patient&rsquo;s chart and is released to them when appropriate — not printed and forgotten.</>,
            <><strong>Coded and exchangeable.</strong> Results map to standard code systems (LOINC / SNOMED CT via the terminology layer) so they mean the same thing everywhere.</>,
            <><strong>Never a fabricated value.</strong> An unmapped concept is carried as text, never given a made-up code — safety over neatness.</>,
          ]}
        />
      </Section>

      <Section title="A focused worklist for lab teams">
        <Prose>
          <p>
            Lab and radiology technicians get a direct, one-click worklist for the queue that is their whole
            job, plus the cross-domain diagnostics overview when they need the wider picture. Accounts are
            provisioned by the facility administrator.
          </p>
        </Prose>
      </Section>

      <PageCta
        title="Close the loop on diagnostics"
        body="Sign in to your diagnostics workspace, or bring Aarogya to your lab."
        actions={[
          { label: "Sign in", href: "/login", primary: true },
          { label: "Talk to us", href: "/company/contact" },
        ]}
      />
    </>
  );
}
