import { expect, test } from "@playwright/test";
import { fixture, signIn } from "./fixture";

/**
 * Flagship 4a — the hospital admin's import review screen: two re-imported
 * patients whose details differ wait in the queue; one is kept as it is, the
 * other accepted, each with a reason; both move to their decided tabs with the
 * reason shown, and the accepted phone is the patient's.
 */
test("import review: keep one, accept one, each with a reason", async ({ page }) => {
  const f = fixture();
  await signIn(page, "/login", f.desk.email, f.password);
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  await page.goto("/hospital-os/enterprise/import-reviews");

  const renamed = page.getByRole("listitem", { name: `Review for ${f.importReview.renamedFrom}` });
  await expect(renamed).toBeVisible();
  await expect(renamed.getByRole("row", { name: new RegExp(`Name\\s+${f.importReview.renamedFrom}\\s+${f.importReview.renamedTo}`) })).toBeVisible();
  const phone = page.getByRole("listitem", { name: `Review for ${f.importReview.phoneChanged}` });
  await expect(phone.getByRole("row", { name: /Phone\s+\+919800022222\s+\+919800033333/ })).toBeVisible();

  // A decision needs a reason.
  await renamed.getByRole("button", { name: "Decide…" }).click();
  await renamed.getByRole("button", { name: "Keep existing" }).click();
  await expect(page.getByText("A reason is required.")).toBeVisible();
  await renamed.getByLabel("Reason").fill("The registration desk confirmed the current name");
  await renamed.getByRole("button", { name: "Keep existing" }).click();
  await expect(page.getByText("The existing details were kept.")).toBeVisible();
  await expect(renamed).toHaveCount(0);

  await phone.getByRole("button", { name: "Decide…" }).click();
  await phone.getByLabel("Reason").fill("The patient confirmed the new number at the desk");
  await phone.getByRole("button", { name: "Accept the import" }).click();
  await expect(page.getByText("The incoming details are now the patient's.")).toBeVisible();
  await expect(phone).toHaveCount(0);

  await page.getByRole("tab", { name: "Kept" }).click();
  await expect(page.getByRole("listitem", { name: `Review for ${f.importReview.renamedFrom}` }).getByText(/Kept the existing details .*: The registration desk confirmed the current name/)).toBeVisible();
  await page.getByRole("tab", { name: "Accepted" }).click();
  await expect(page.getByRole("listitem", { name: `Review for ${f.importReview.phoneChanged}` }).getByText(/Accepted .*: The patient confirmed the new number at the desk/)).toBeVisible();

});
