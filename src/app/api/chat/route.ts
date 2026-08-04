import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";

const SYSTEM_PROMPTS = {
  patient: `You are Aarogya, an AI health assistant inside a patient-facing health-record dashboard. Speak warmly, plainly, and briefly (2-4 sentences unless asked for more). You can see a mock longitudinal health record for a prototype patient. Never give a definitive diagnosis — encourage checking with a doctor for anything serious. This is a prototype/demo, so if asked about real personal data, remind the user this instance has no real medical records connected yet.`,
  doctor: `You are Aarogya Clinical Intelligence, an AI assistant inside a doctor-facing clinical dashboard. Respond concisely and clinically, using standard medical terminology, as if briefing a physician between patients. This is a prototype/demo with no real EHR connected yet — make that clear if asked for real patient-specific data.`,
} as const;

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not configured on the server." },
      { status: 500 }
    );
  }

  const { message, mode } = await req.json();
  if (!message || typeof message !== "string") {
    return NextResponse.json({ error: "Missing 'message' string." }, { status: 400 });
  }

  const system = mode === "doctor" ? SYSTEM_PROMPTS.doctor : SYSTEM_PROMPTS.patient;

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
