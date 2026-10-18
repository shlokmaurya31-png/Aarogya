"use client";

import { useEffect, useState } from "react";
import { RecordAi, type RecordAiMode } from "./RecordAi";

/**
 * Week 4b — the AI panel on a staff member's view of one patient: the modes
 * their role may use (doctor: visit brief, chart Q&A, timeline; nurse: chart
 * Q&A and handoff for assigned patients), with the doctor's next appointment
 * with the patient as the visit brief's reason. Whether this patient may be
 * asked about is decided by the server on every request.
 */
export function ChartAi({ patientId, title = "AI assistant (advisory)" }: { patientId: string; title?: string }) {
  const [me, setMe] = useState<{ modes: RecordAiMode[]; appointmentId?: string | null } | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`/api/ai/me?patientId=${encodeURIComponent(patientId)}`).then((r) => (r.ok ? r.json() : null)).then((d) => alive && setMe(d)).catch(() => undefined);
    return () => { alive = false; };
  }, [patientId]);
  if (!me?.modes?.length) return null;
  return <RecordAi key={patientId} patientId={patientId} modes={me.modes} appointmentId={me.appointmentId} title={title} />;
}
