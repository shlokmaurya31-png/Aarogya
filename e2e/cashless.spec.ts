import { expect, test } from "@playwright/test";
import { fixture, signIn } from "./fixture";
import { hospitalStep } from "./steps";

/**
 * Flagship 5, step 5 — cashless through the mock NHCX adapter
 * (docs/CASHLESS_CLAIMS_DESIGN.md §12): the patient is admitted with verified
 * insurance → the desk starts a pre-authorisation from the admission,
 * proposing two hospital documents → the patient sends one and keeps the
 * other back → the insurer asks a question → the desk answers, adding the
 * estimate → the patient approves it → the insurer approves → the patient
 * sees "Approved ₹40,000; your share ₹10,000".
 */
test("cashless: admit → pre-auth → patient approves documents → query → answer → approval → the patient sees the decision", async ({ browser }) => {
  const f = fixture();
  const a = hospitalStep<{ encounterId: string; name: string; email: string; diagnosis: string; note: string; usg: string; estimate: string }>("cashless-admission");

  const desk = await (await browser.newContext()).newPage();
  await signIn(desk, "/login", f.desk.email, f.password);
  await desk.waitForURL((u) => !u.pathname.startsWith("/login"));
  const patient = await (await browser.newContext()).newPage();
  await signIn(patient, "/patient/login", a.email, f.password);
  await patient.waitForURL((u) => u.pathname === "/patient");

  // The desk starts the request from the admission.
  await desk.goto("/hospital-os/claims/cashless");
  const candidate = desk.getByRole("listitem", { name: `${a.name}, ${a.diagnosis}` });
  await candidate.getByRole("button", { name: "Start cashless" }).click();
  const form = desk.getByRole("region", { name: `Start cashless for ${a.name}` });
  await expect(form.getByLabel("Diagnosis")).toHaveValue(a.diagnosis);
  await form.getByLabel("Planned procedure").fill("Laparoscopic appendectomy");
  await form.getByLabel("Estimate in rupees").fill("50000");
  await form.getByLabel(a.note).check();
  await form.getByLabel(a.usg).check();
  await form.getByRole("button", { name: "Ask the patient to approve" }).click();
  const req = desk.getByRole("listitem", { name: `Cashless for ${a.name}` });
  await expect(req.getByRole("status")).toHaveText("Waiting for the patient to approve documents");

  // The patient sends the admission note and keeps the ultrasound back.
  await patient.goto("/patient/insurance");
  const mine = patient.getByRole("region", { name: /^Cashless at / });
  await expect(mine.getByRole("status")).toContainText("needs your approval");
  await mine.getByRole("group", { name: a.usg }).getByLabel("Don't send").check();
  await mine.getByRole("button", { name: "Confirm my choices" }).click();
  await expect(mine.getByRole("status")).toContainText("waiting for your insurer");
  await expect(mine.getByText(`${a.usg}: not sent (you removed it)`)).toBeVisible();

  // The insurer asks; the desk answers, adding the estimate.
  hospitalStep("cashless-insurer", JSON.stringify({ encounterId: a.encounterId, decision: "QUERY", queryText: "Please send the cost estimate for the procedure." }));
  await desk.reload();
  await expect(req.getByRole("status")).toHaveText("The insurer asked a question");
  await expect(req.getByLabel("Insurer's question")).toHaveText("Please send the cost estimate for the procedure.");
  await req.getByLabel("Answer to the insurer").fill("The hospital's estimate for the procedure is attached.");
  await req.getByLabel(a.estimate).check();
  await req.getByRole("button", { name: "Send the answer" }).click();
  await expect(req.getByRole("status")).toHaveText("Waiting for the patient to approve documents");

  // The patient approves the estimate; the answer goes.
  await patient.reload();
  await expect(mine.getByRole("group", { name: a.estimate })).toBeVisible();
  await expect(mine.getByText("Please send the cost estimate")).toHaveCount(0);
  await mine.getByRole("button", { name: "Confirm my choices" }).click();
  await expect(mine.getByRole("status")).toContainText("waiting for your insurer");
  await desk.reload();
  await expect(req.getByRole("status")).toHaveText("With the insurer");

  // The insurer approves ₹40,000 of the ₹50,000 estimate.
  hospitalStep("cashless-insurer", JSON.stringify({ encounterId: a.encounterId, decision: "APPROVED", approvedAmountMinor: 4_000_000 }));
  await patient.reload();
  await expect(mine.getByRole("status")).toContainText("approved cashless");
  await expect(mine.getByLabel("Cashless decision")).toHaveText("Approved ₹40,000; your share ₹10,000");
  await expect(mine.getByText(/Based on the hospital's estimate; the final bill is at discharge/)).toBeVisible();
  await desk.reload();
  await expect(desk.getByRole("listitem", { name: `Cashless for ${a.name}` }).getByRole("status")).toHaveText("Approved");
});
