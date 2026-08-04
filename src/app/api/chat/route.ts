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
  hospitalBeds,
} from "@/lib/mock-data";
import type {
  Appointment,
  BodySystem,
  InsuranceClaim,
  PatientProfile,
  Prescription,
  ReportDoc,
  TimelineEvent,
  VitalSeries,
} from "@/types";

interface PatientDataPayload {
  profile: PatientProfile | null;
  vitals: VitalSeries[];
  bodySystems: BodySystem[];
  timeline: TimelineEvent[];
  appointments: Appointment[];
  reports: ReportDoc[];
  prescriptions: Prescription[];
  insuranceClaims: InsuranceClaim[];
}

function buildHospitalBlock() {
  return hospitalBeds
    .map(
      (h) =>
        `- ${h.name} (${h.city}, ${h.distanceKm} km): ${h.emergencyBeds} emergency, ${h.icuBeds} ICU, ${h.generalBeds} general beds free, ~${h.avgWaitMinutes} min ER wait without booking`
    )
    .join("\n");
}

const HOSPITAL_BLOCK = buildHospitalBlock();

function buildDoctorRecordContext() {
  const vitalsBlock = vitals
    .map((v) => `- ${v.label}: ${v.current} ${v.unit} (${v.risk}, ${v.delta >= 0 ? "+" : ""}${v.delta} recent trend)`)
    .join("\n");

  const systemsBlock = bodySystems
    .map((s) => `- ${s.name} [${s.status}]: ${s.summary} Last checked ${s.lastChecked}.`)
    .join("\n");

  const labsBlock = labResults
    .map((l) => `- ${l.test} (${l.panel}): ${l.value} ${l.unit}, reference ${l.refLow}-${l.refHigh}, flag: ${l.risk}, ${l.date}`)
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

  return `PATIENT RECORD: ${patient.name} (${patient.patientId})
Age ${patient.age}, ${patient.gender}, ${patient.bloodGroup}, ${patient.height}, ${patient.weight}
Allergies: ${patient.allergies.join(", ")}
Insurance: ${patient.insurance} · Ayushman Bharat: ${patient.ayushmanBharat}
TPA: ${patient.tpa.name} · Health Card ID: ${patient.tpa.healthCardId} · Policy: ${patient.tpa.policyNumber} · Helpline: ${patient.tpa.helpline}

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

NEARBY HOSPITAL BED AVAILABILITY (live counts shown on the Emergency page's Instant Bed Booking panel)
${HOSPITAL_BLOCK}

TREATING DOCTOR
${doctorProfile.name}, ${doctorProfile.specialty}, ${doctorProfile.facility} (${doctorProfile.registrationId})`;
}

const DOCTOR_RECORD_CONTEXT = buildDoctorRecordContext();

function buildPatientRecordContext(data: PatientDataPayload | null | undefined) {
  const profile = data?.profile;
  if (!profile) {
    return `PATIENT RECORD: not yet completed. This person hasn't finished their Aarogya profile, so there is no age, blood group, allergy, or history data to draw on. If they ask something that depends on that, gently point them to finishing their profile setup, and otherwise just answer generally.

NEARBY HOSPITAL BED AVAILABILITY (live counts shown on the Emergency page's Instant Bed Booking panel)
${HOSPITAL_BLOCK}`;
  }

  const vitalsBlock = data.vitals.length
    ? data.vitals.map((v) => `- ${v.label}: ${v.current} ${v.unit} (${v.risk})`).join("\n")
    : "No vitals tracked yet.";

  const systemsBlock = data.bodySystems.length
    ? data.bodySystems.map((s) => `- ${s.name} [${s.status}]: ${s.summary}`).join("\n")
    : "No body system checkups on file yet.";

  const rxBlock = data.prescriptions.length
    ? data.prescriptions
        .map((p) => `- ${p.drug} ${p.dose}, ${p.frequency}, prescribed by ${p.prescribedBy}, status: ${p.status}`)
        .join("\n")
    : "No active prescriptions.";

  const timelineBlock = data.timeline.length
    ? data.timeline
        .slice(0, 5)
        .map((e) => `- ${e.date} · ${e.title} (${e.facility}): ${e.description}`)
        .join("\n")
    : "No history recorded yet.";

  const apptBlock = data.appointments.filter((a) => a.status === "upcoming").length
    ? data.appointments
        .filter((a) => a.status === "upcoming")
        .map((a) => `- ${a.date} ${a.time} · ${a.doctor} (${a.specialty}) · ${a.mode} · ${a.facility}`)
        .join("\n")
    : "No upcoming appointments booked.";

  const reportsBlock = data.reports.length
    ? data.reports.map((r) => `- ${r.title} (${r.kind}), ${r.facility}, ${r.date}`).join("\n")
    : "No reports uploaded yet.";

  const claimsBlock = data.insuranceClaims.length
    ? data.insuranceClaims.map((c) => `- ${c.claimNo}: ${c.reason}, ₹${c.amount}, ${c.status} (${c.date})`).join("\n")
    : "No claims filed.";

  return `PATIENT RECORD: ${profile.name} (${profile.patientId})
Age ${profile.age}, ${profile.gender}, ${profile.bloodGroup}, ${profile.height}, ${profile.weight}
Allergies: ${profile.allergies.join(", ")}
Insurance: ${profile.insurance}
TPA: ${profile.tpa.name} · Health Card ID: ${profile.tpa.healthCardId} · Policy: ${profile.tpa.policyNumber} · Helpline: ${profile.tpa.helpline}

VITALS
${vitalsBlock}

BODY SYSTEMS
${systemsBlock}

ACTIVE PRESCRIPTIONS
${rxBlock}

RECENT TIMELINE
${timelineBlock}

UPCOMING APPOINTMENTS
${apptBlock}

REPORTS
${reportsBlock}

INSURANCE CLAIMS
${claimsBlock}

NEARBY HOSPITAL BED AVAILABILITY (live counts shown on the Emergency page's Instant Bed Booking panel)
${HOSPITAL_BLOCK}`;
}

function buildPatientSystemPrompt(data: PatientDataPayload | null | undefined) {
  const name = data?.profile?.name ?? "this patient";
  const hasProfile = Boolean(data?.profile);
  return `You are Aarogya, ${name}'s personal AI health assistant inside their Aarogya health record dashboard. You have access to their record below (it may be sparse or empty if they're new). Treat it as ground truth, only reference facts actually listed there, and don't invent history that isn't present. Speak warmly, plainly, and briefly (2-4 sentences unless asked for more detail).

Stay in character at all times. Do not say you are an AI language model or a demo. ${
    hasProfile
      ? "You have their real record, use it."
      : "They haven't finished onboarding yet, so be upfront that you don't have their details rather than guessing or inventing any."
  }

Clinical judgment: don't hand out definitive diagnoses or replace a doctor's decision. Ground specific findings in the record and suggest confirming plans with a doctor when it matters, but do this naturally as part of good care, not as a disclaimer. If they describe something that sounds like a medical emergency (chest pain, trouble breathing, stroke symptoms, severe bleeding, etc.), tell them clearly to seek immediate/emergency care, and recommend the nearest hospital with a free bed and the shortest wait from the list below.

If asked to book a hospital bed, you can't complete the booking yourself in chat. Point them to the "Instant Bed Booking" panel on the Emergency page, tell them which hospital currently looks best (shortest wait, beds free in the category they need), and remind them the confirmation code from that panel gets them past the ER queue at the admission desk.

${buildPatientRecordContext(data)}`;
}

const DOCTOR_SYSTEM_PROMPT = `You are Aarogya Clinical Intelligence, an AI assistant inside the clinician dashboard, currently briefing ${doctorProfile.name} on the chart open below. Respond concisely and clinically, using standard medical terminology, as if briefing a physician between patients. Treat the record as ground truth and cite specific values, trends, and dates from it.

Stay in character at all times. Do not say you are an AI language model, a prototype, or a demo, and do not claim you lack access to the chart. You have it, use it.

If asked about admitting the patient or booking a bed, you can't complete the booking yourself in chat. Point to the "Instant Bed Booking" panel on the Emergency page and recommend the best option from the list below (shortest wait, beds free in the needed category).

${DOCTOR_RECORD_CONTEXT}`;

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not configured on the server." },
      { status: 500 }
    );
  }

  const { message, mode, page, patientData } = await req.json();
  if (!message || typeof message !== "string") {
    return NextResponse.json({ error: "Missing 'message' string." }, { status: 400 });
  }

  const basePrompt = mode === "doctor" ? DOCTOR_SYSTEM_PROMPT : buildPatientSystemPrompt(patientData);
  const system =
    typeof page === "string" && page.trim()
      ? `${basePrompt}\n\nThe user is currently viewing the "${page}" section of the dashboard. When their question is general or open-ended, lean your default focus toward what's most useful on that section, but always answer whatever they actually ask, even if it's about something else.`
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
