import { expect, test } from "@playwright/test";
import { fixture, signIn } from "./fixture";

/**
 * The patient's journey with an upload: sign in → upload a sample report →
 * it is read (mock providers; a scan-like PDF, so rasterized and OCR'd) →
 * review and confirm what was found → see it on the timeline, labelled as
 * from their document → "explain my report" with the AI label and cited lines.
 */
test("patient: upload, review, timeline, explain", async ({ page }) => {
  const f = fixture();
  await signIn(page, "/patient/login", f.patient.email, f.password);
  await page.waitForURL((u) => u.pathname === "/patient");

  // Upload.
  await page.goto("/patient/documents");
  await page.getByLabel("Report file").setInputFiles(f.samplePdf);
  await page.getByLabel("Title").fill(f.sampleTitle);
  await page.getByRole("button", { name: "Upload" }).click();
  const row = page.locator("li", { hasText: f.sampleTitle });
  await expect(row).toBeVisible();

  // Processed by the worker (mock OCR and extraction), then ready for review.
  await expect(row.getByText("Ready for your review")).toBeVisible({ timeout: 90_000 });
  await row.getByRole("button", { name: "Review" }).click();
  const review = row.getByLabel("Review what we found");
  await expect(review.getByText("Hemoglobin 11.2 g/dL")).toBeVisible();

  // Confirm: every clearly printed line at once, then whatever is left one by one.
  const bulk = review.getByRole("button", { name: /^Confirm all \d+ clearly printed lines$/ });
  if (await bulk.isVisible()) await bulk.click();
  const allDone = row.getByText("Everything here is reviewed.");
  await expect(async () => {
    if (await allDone.isVisible()) return;
    await review.getByRole("button", { name: "Confirm", exact: true }).first().click({ timeout: 2_000 });
    throw new Error("more lines to confirm");
  }).toPass({ timeout: 60_000 });

  // The timeline shows the confirmed values, labelled as from the patient's document (after the merge consumer runs).
  await expect(async () => {
    await page.goto("/patient/records");
    await expect(page.getByText("Lab result from the patient's document: Hemoglobin 11.2 g/dL")).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });

  // Explain my report: the AI label, an answer, its sources.
  await page.goto("/patient/reports");
  const report = page.locator("li", { hasText: f.sampleTitle });
  await report.getByRole("button", { name: "Explain" }).click();
  const ai = page.locator("section[aria-label]").filter({ has: page.getByRole("tab", { name: "Explain this report" }) });
  await ai.getByRole("tab", { name: "Explain this report" }).click();
  await ai.getByRole("button", { name: "Generate" }).click();
  await expect(ai.getByText(/AI-generated/i)).toBeVisible();
  await expect(ai.locator("ol li").first()).toBeVisible();
  await expect(ai.locator("ol li sup").first()).toBeVisible();
  await expect(ai.getByText("Sources")).toBeVisible();
});
