/**
 * Week 4c — sensitive categories hidden by default (docs/CONSENT_SHARING_DESIGN.md §6, §10):
 * an HIV result (labs), buprenorphine (a substance-use medicine, live in the
 * AI's facts), a VDRL entry (sexual health) and a beta-hCG entry
 * (reproductive health) from the person's uploads, behind a share with
 * every category but no opt-ins:
 *   - each is absent from the consult view and from the AI, and leaves no
 *     placeholder; an ordinary result beside them is there (control);
 *   - an opt-in admits only its own category;
 *   - a new share starts with no opt-ins again;
 *   - the treating path is unchanged (it sees them).
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-sensitive-categories.ts
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { issueAccessCode, redeemAccessCode } from "../src/lib/patient/accessSession";
import { parseShareChoice } from "../src/lib/sharing/categories";
import { viewSharedRecord } from "../src/lib/sharing/view";
import { resolveAiAccess } from "../src/lib/rag/access";
import { retrieve } from "../src/lib/rag/retrieve";
import { PUNE, drain, lab, medicine, provided, reporter, sharer, staff, tag } from "./lib/shareFixture";

const { report, done } = reporter();

async function main() {
  registerAllConsumers();
  const P = await sharer();
  const doc = await staff(PUNE, "DOCTOR");
  await lab(P.pune, P.punEnc, "Haemoglobin", `12.0 plain${tag}`);
  await lab(P.pune, P.punEnc, "HIV 1/2 antibody", `Non-reactive hivlab${tag}`);
  await medicine(P.pune, P.punEnc, `Buprenorphine subst${tag}`);
  await provided(P.personId, "LAB_RESULT", { analyte: "VDRL", value: `Non-reactive sti${tag}` });
  await provided(P.personId, "LAB_RESULT", { analyte: "Beta hCG", value: `2 repro${tag}` });
  await drain();
  const all = ["PRESCRIPTIONS", "LABS", "IMAGING", "DISCHARGE_SUMMARIES", "UPLOADS"];
  const open = async (sensitiveCategories: string[] = []) => {
    const issued = await issueAccessCode(P.pune, P.userId, "gate", { choice: parseShareChoice({ categories: all, sensitiveCategories }) });
    const s = await redeemAccessCode({ code: issued.code, doctorUserId: doc.userId, doctorStaffId: doc.staffId, doctorName: "Gate", facilityId: PUNE });
    return s!.id;
  };
  const view = async (ref: string) => JSON.stringify((await viewSharedRecord(doc.actor, ref, "CONSULT_VIEW")).history);
  // What retrieval hands the model for the question (chunks and live facts), as the leak gate checks.
  const ai = async (ref: string | undefined, question: string) => {
    const access = await resolveAiAccess({ kind: "STAFF", userId: doc.userId, role: "DOCTOR", facilityId: PUNE }, { mode: "CHART_QA", patientId: P.pune, ...(ref ? { shareId: ref } : {}) });
    // With the question (the threshold applies) and without (everything in scope, live facts included).
    const [r, r2] = [await retrieve(access, { question }), await retrieve(access, {})];
    return JSON.stringify([r.chunks, r.live, r2.chunks, r2.live]);
  };

  const none = await open();
  const v0 = await view(none);
  report("No opt-ins: the ordinary result is there (control)", v0.includes(`plain${tag}`));
  report("…the HIV result is absent from the consult view", !v0.includes(`hivlab${tag}`) && !/hiv/i.test(v0));
  report("…buprenorphine is absent", !v0.includes(`subst${tag}`));
  report("…the VDRL and beta-hCG entries are absent", !v0.includes(`sti${tag}`) && !v0.includes(`repro${tag}`));
  report("…and nothing marks that something was withheld", !/withheld|hidden|sensitive item/i.test(v0));
  report("The AI through the share: no HIV result", !(await ai(none, `hivlab${tag} result`)).includes(`hivlab${tag}`));
  report("…no buprenorphine among the live medicines", !(await ai(none, `subst${tag} medicine`)).includes(`subst${tag}`));
  report("…no VDRL entry", !(await ai(none, `sti${tag} VDRL`)).includes(`sti${tag}`));

  const hiv = await open(["HIV"]);
  const vh = await view(hiv);
  report("An HIV opt-in: the HIV result is there", vh.includes(`hivlab${tag}`) && (await ai(hiv, `hivlab${tag} result`)).includes(`hivlab${tag}`));
  report("…and only that: buprenorphine, VDRL, beta-hCG still absent", !vh.includes(`subst${tag}`) && !vh.includes(`sti${tag}`) && !vh.includes(`repro${tag}`));
  const subst = await open(["SUBSTANCE_USE"]);
  report("A substance-use opt-in: buprenorphine in the view, and HIV absent again", (await view(subst)).includes(`subst${tag}`) && !(await view(subst)).includes(`hivlab${tag}`));
  const aiSubst = await ai(subst, `subst${tag} medicine`);
  report("…and among the AI's live medicines", aiSubst.includes(`subst${tag}`), aiSubst.slice(0, 400));
  const sexRepro = await open(["SEXUAL_HEALTH", "REPRODUCTIVE_HEALTH"]);
  const vs = await view(sexRepro);
  report("Sexual and reproductive health opt-ins: both uploaded entries are there", vs.includes(`sti${tag}`) && vs.includes(`repro${tag}`));
  report("…and the AI finds the VDRL entry through that share (control for the absence above)", (await ai(sexRepro, `sti${tag} VDRL`)).includes(`sti${tag}`));
  const again = await open();
  report("A new share starts with no opt-ins again", !(await view(again)).includes(`hivlab${tag}`) && (await prisma.recordShare.findFirstOrThrow({ where: { session: { id: again } } })).sensitiveCategories.length === 0);
  report("The treating path is unchanged: it sees the HIV result", (await ai(undefined, `hivlab${tag} result`)).includes(`hivlab${tag}`));

  await done();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
