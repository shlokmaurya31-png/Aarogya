import { expect, test } from "@playwright/test";
import { fixture, signIn } from "./fixture";

/**
 * The doctor's journey with a share: sign in → open the consult the
 * patient's visit code opened (an appointment today) → generate the visit
 * brief → cited lines, each with its labels, and the sources list.
 */
test("doctor: visit brief from a share, with cited, labelled lines", async ({ page }) => {
  const f = fixture();
  await signIn(page, "/login", f.doctor.email, f.password);
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));

  await page.goto(`/consult/${f.shareId}`);
  await expect(page.getByText(f.patient.name)).toBeVisible();
  const ai = page.getByRole("region", { name: "Visit brief from the shared record (cited, advisory)" });
  await expect(ai).toBeVisible();
  await ai.getByRole("tab", { name: "Visit brief" }).click();
  await ai.getByRole("button", { name: "Generate" }).click();

  await expect(ai.getByText(/AI-generated/i)).toBeVisible();
  const lines = ai.locator("ol li");
  await expect(lines.first()).toBeVisible();
  // A cited line about the shared hemoglobin result, labelled verified.
  const hb = lines.filter({ hasText: "10.4" });
  await expect(hb.first()).toBeVisible();
  await expect(hb.first().locator("sup").first()).toBeVisible();
  await expect(hb.first().getByText("verified", { exact: true })).toBeVisible();
  await expect(ai.getByText("Sources")).toBeVisible();
});
