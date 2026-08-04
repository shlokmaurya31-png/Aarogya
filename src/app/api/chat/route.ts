import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import {
  patient,
  doctorProfile,
  vitals,
  bodySystems,
  timeline,
  labResults,
  prescriptions,
  appointments,
  insuranceClaims,
} from "@/lib/mock-data";

function buildRecordContext() {
  const vitalsBlock = vitals
    .map((v) => `- ${v.label}: ${v.current} ${v.unit} (${v.risk}, ${v.delta >= 0 ? "+" : ""}${v.delta} recent trend)`)
    .join("\n");

  const systemsBlock = bodySystems
    .map((s) => `- ${s.name} [${s.status}]: ${s.summary} Last checked ${s.lastChecked}.`)
    .join("\n");

  const labsBlock = labResults
    .map((l) => `- ${l.test} (${l.panel}): ${l.value} ${l.unit}, reference ${l.refLow}-${l.refHigh}, flag: ${l.risk} — ${l.date}`)
    .join("\n");

  const rxBlock = prescriptions
    .map((p) => `- ${p.drug} ${p.dose}, ${p.frequency}, prescribed by ${p.prescribedBy}, status: ${p.status}, adherence ${p.adherence}%`)
    .join("\n");

  const timelineBlock = timeline
    .slice(0, 5)
    .map((e) => `- ${e.date} · ${e.title} (${e.facility}): ${e.description}`)
    .join("\n");

  const apptBlock = appointments
    .filter((a) => a.status === "upcoming")
    .map((a) => `- ${a.date} ${a.time} · ${a.doctor} (${a.specialty}) · ${a.mode} · ${a.facility}`)
    .join("\n");

  const claimsBlock = insuranceClaims
    .map((c) => `- ${c.claimNo}: ${c.reason}, ₹${c.amount}, ${c.status} (${c.date})`)
    .join("\n");

  return `PATIENT RECORD — ${patient.name} (${patient.patientId})
Age ${patient.age}, ${patient.gender}, ${patient.bloodGroup}, ${patient.height}, ${patient.weight}
Allergies: ${patient.allergies.join(", ")}
Insurance: ${patient.insurance} · Ayushman Bharat: ${patient.ayushmanBharat}

VITALS
${vitalsBlock}

BODY SYSTEMS
${systemsBlock}

RECENT LAB RESULTS
${labsBlock}

ACTIVE PRESCRIPTIONS
${rxBlock}

RECENT TIMELINE
${timelineBlock}

UPCOMING APPOINTMENTS
${apptBlock}

INSURANCE CLAIMS
${claimsBlock}

TREATING DOCTOR
${doctorProfile.name}, ${doctorProfile.specialty}, ${doctorProfile.facility} (${doctorProfile.registrationId})`;
}

const RECORD_CONTEXT = buildRecordContext();

const SYSTEM_PROMPTS = {
  patient: `You are Aarogya, ${patient.name}'s personal AI health assistant inside their Aarogya health record dashboard. You have full access to their record below — treat it as ground truth and answer directly and specifically from it, the way a well-informed care assistant who has read the whole chart would. Speak warmly, plainly, and briefly (2-4 sentences unless asked for more detail).

Stay in character at all times. Do not say you are an AI language model, a prototype, a demo, or that you lack access to real data — you have the record, use it.

Clinical judgment: don't hand out definitive diagnoses or replace a doctor's decision — ground specific findings in the record and suggest confirming plans with ${doctorProfile.name} or the relevant specialist when it matters, but do this naturally as part of good care, not as a disclaimer. If the patient describes something that sounds like a medical emergency (chest pain, trouble breathing, stroke symptoms, severe bleeding, etc.), tell them clearly to seek immediate/emergency care.

${RECORD_CONTEXT}`,

  doctor: `You are Aarogya Clinical Intelligence, an AI assistant inside the clinician dashboard, currently briefing ${doctorProfile.name} on the chart open below. Respond concisely and clinically, using standard medical terminology, as if briefing a physician between patients. Treat the record as ground truth and cite specific values, trends, and dates from it.

Stay in character at all times. Do not say you are an AI language model, a prototype, or a demo, and do not claim you lack access to the chart — you have it, use it.

${RECORD_CONTEXT}`,
} as const;

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not configured on the server." },
      { status: 500 }
    );
  }

  const { message, mode, page } = await req.json();
  if (!message || typeof message !== "string") {
    return NextResponse.json({ error: "Missing 'message' string." }, { status: 400 });
  }

  const basePrompt = mode === "doctor" ? SYSTEM_PROMPTS.doctor : SYSTEM_PROMPTS.patient;
  const system =
    typeof page === "string" && page.trim()
      ? `${basePrompt}\n\nThe user is currently viewing the "${page}" section of the dashboard. When their question is general or open-ended, lean your default focus toward what's most useful on that section — but always answer whatever they actually ask, even if it's about something else.`
      : basePrompt;

  try {
    const anthropic = new Anthropic({ apiKey });
    const response = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 512,
      system,
      messages: [{ role: "user", content: message }],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    return NextResponse.json({ text });
  } catch (err) {
    console.error("Anthropic API error:", err);
    return NextResponse.json({ error: "AI request failed." }, { status: 502 });
  }
}
