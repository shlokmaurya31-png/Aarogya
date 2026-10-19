"use client";

import { useEffect, useState } from "react";
import { RecordAi, type RecordAiMode } from "./RecordAi";

/**
 * Week 4b — the AI panel in the patient portal: explain a report, the health
 * timeline, questions for the next visit; in the patient's language. Uses the
 * patient's own record (their first linked facility record names them; the
 * server answers from all of their own records).
 */
export function PatientAi({ modes, documentId, title = "Ask about my records (AI, advisory)" }: { modes: RecordAiMode[]; documentId?: string; title?: string }) {
  const [me, setMe] = useState<{ patients: { patientId: string }[]; language: string } | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/ai/me").then((r) => (r.ok ? r.json() : null)).then((d) => alive && setMe(d)).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  const patientId = me?.patients?.[0]?.patientId;
  if (!patientId) return null;
  return <RecordAi patientId={patientId} modes={modes} documentId={documentId} patient defaultLanguage={me!.language} title={title} />;
}
