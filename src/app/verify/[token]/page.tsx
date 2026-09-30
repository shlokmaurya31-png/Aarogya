import { verifyDocumentByToken } from "@/lib/documents/verify";

/**
 * Phase 1.2 — public document authenticity page.
 *
 * Reachable without authentication (it is the QR target on every generated PDF).
 * It confirms a document is genuine and shows only non-PHI facts: title, issuing
 * facility, document number, issue date and draft status. It never reveals the
 * patient or any clinical/financial content.
 */
export const dynamic = "force-dynamic";

export default async function VerifyDocumentPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await verifyDocumentByToken(token);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-6 px-6 py-12">
      <div className="w-full rounded-2xl border border-black/10 bg-white p-8 text-neutral-900 shadow-sm dark:border-white/10 dark:bg-neutral-900 dark:text-neutral-100">
        {result.valid ? (
          <>
            <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-teal-50 px-3 py-1 text-[12px] font-semibold text-teal-700 dark:bg-teal-950 dark:text-teal-300">
              <span aria-hidden>✓</span> Authentic document
            </div>
            <h1 className="text-[18px] font-semibold">{result.title}</h1>
            {result.isDraft && (
              <p className="mt-1 text-[12px] font-medium text-amber-600">This is a DRAFT and is not a final issued document.</p>
            )}
            <dl className="mt-5 space-y-3 text-[13px]">
              <div className="flex justify-between gap-4">
                <dt className="text-neutral-500">Issued by</dt>
                <dd className="text-right font-medium">{result.facilityName ?? "-"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-neutral-500">Document No.</dt>
                <dd className="text-right font-mono">{result.documentNumber}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-neutral-500">Issued on</dt>
                <dd className="text-right">{result.issuedOn}</dd>
              </div>
            </dl>
            <p className="mt-6 text-[11px] leading-relaxed text-neutral-500">
              This page confirms the document was genuinely issued through Aarogya. For privacy, no patient
              or clinical information is shown here.
            </p>
          </>
        ) : (
          <>
            <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-red-50 px-3 py-1 text-[12px] font-semibold text-red-700 dark:bg-red-950 dark:text-red-300">
              <span aria-hidden>✕</span> Not verified
            </div>
            <h1 className="text-[18px] font-semibold">This document could not be verified</h1>
            <p className="mt-3 text-[13px] leading-relaxed text-neutral-500">
              The verification code is invalid or has expired. If you received this document from a hospital,
              please contact them to confirm its authenticity.
            </p>
          </>
        )}
      </div>
      <p className="text-[11px] text-neutral-400">Verified by Aarogya</p>
    </main>
  );
}
