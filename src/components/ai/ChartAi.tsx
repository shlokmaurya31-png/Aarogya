"use client";

import { useEffect, useState } from "react";
import { RecordAi, type RecordAiMode } from "./RecordAi";

/**
 * Week 4b — the AI panel on a staff member's view of one patient: the modes
 * their role may use (doctor: visit brief, chart Q&A, timeline; nurse: chart
 * Q&A and handoff for assigned patients), with the doctor's next appointment
 * with the patient as the visit brief's reason. Whether this patient may be
 * asked about is decided by the server on every request.
 * With `shareId` (a visit code the patient gave this doctor; Week 4c), only
 * the visit brief and chart Q&A, over what the share covers.
 */
const SHARE_MODES: RecordAiMode[] = ["VISIT_BRIEF", "CHART_QA"];

export function ChartAi({ patientId, shareId, title = "AI assistant (advisory)" }: { patientId: string; shareId?: string; title?: string }) {
  const [me, setMe] = useState<{ modes: RecordAiMode[]; appointmentId?: string | null } | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`/api/ai/me?patientId=${encodeURIComponent(patientId)}`).then((r) => (r.ok ? r.json() : null)).then((d) => alive && setMe(d)).catch(() => undefined);
    return () => { alive = false; };
  }, [patientId]);
  const modes = shareId ? (me?.modes ?? []).filter((m) => SHARE_MODES.includes(m)) : me?.modes ?? [];
  if (!modes.length) return null;
  return <RecordAi key={patientId} patientId={patientId} modes={modes} appointmentId={me?.appointmentId} shareId={shareId} title={title} />;
}
