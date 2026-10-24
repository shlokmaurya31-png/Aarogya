import { expect, test } from "@playwright/test";
import { fixture, signIn } from "./fixture";
import { hospitalStep } from "./steps";

/**
 * Week 5 final — an inpatient medication round with a missed dose: an
 * admitted patient's medicine is ordered, verified and dispensed; on the
 * nurse's shift the dose due now is given (the five rights confirmed); the
 * one nobody recorded five hours ago was marked missed by the runner's sweep
 * and is not offered as due.
 */
test("medication round: give the due dose; the late one is marked missed", async ({ page }) => {
  const f = fixture();
  const ward = hospitalStep<{ name: string; orderId: string; drugName: string }>("med-round");
  await signIn(page, "/login", f.nurse.email, f.password);
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  await page.goto("/hospital-os/nurse");
  const dose = page.locator("div.rounded-lg").filter({ hasText: ward.name }).filter({ hasText: ward.drugName }).first();
  await expect(dose).toBeVisible();
  await dose.getByRole("button", { name: "Administer" }).click();
  await dose.getByLabel(/Right patient/).check();
  await dose.getByRole("button", { name: "Give" }).click();

  await expect(page.getByText("Medication administered.").first()).toBeVisible();
  await expect(async () => {
    const { doses } = hospitalStep<{ doses: { status: string; recorded: boolean }[] }>("mar", ward.orderId);
    expect(doses.some((d) => d.status === "GIVEN" && d.recorded)).toBe(true);
    expect(doses.some((d) => d.status === "MISSED" && !d.recorded)).toBe(true);
  }).toPass({ timeout: 60_000 });
  await page.reload();
  await expect(page.getByText("Missed doses").first()).toBeVisible();
});
