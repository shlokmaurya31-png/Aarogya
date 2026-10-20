import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { fixture, signIn } from "./fixture";

/** The parental-consent code the app sent to the parent's phone (the SMS outbox of the smoke run). */
function lastCode(phone: string): string {
  const lines = readFileSync(path.join(process.cwd(), ".data", "outbox", "sms.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { to: string; text: string });
  const m = /(\d{6})/.exec(lines.filter((x) => x.to === phone).pop()?.text ?? "");
  if (!m) throw new Error("no code sent");
  return m[1];
}

/**
 * Week 5b — a parent in the browser: starts a household, adds a child with
 * the parental-consent code sent to their phone, switches to the child's
 * profile, uploads a report for them, and confirms what was read: the values
 * enter the child's record, labelled as confirmed by proxy.
 */
test("household: add a child, switch to them, upload and confirm for them", async ({ page }) => {
  const f = fixture();
  await signIn(page, "/patient/login", f.patient.email, f.password);
  await page.waitForURL((u) => u.pathname === "/patient");
  await page.goto("/patient/household");
  await page.getByRole("button", { name: "Start a household" }).click();
  await page.getByRole("button", { name: "Add a child" }).click();
  const add = page.getByRole("region", { name: "Add a child" });
  await add.getByLabel("Child's name").fill(`Smoke Child ${f.tag}`);
  await add.getByLabel("Date of birth").fill("2019-06-15");
  await add.getByRole("checkbox").check();
  await add.getByRole("button", { name: "Send me a code" }).click();
  await expect(add.getByText(/We sent a code to your phone/)).toBeVisible();
  await add.getByLabel("Code").fill(lastCode(f.patient.verifiedPhone));
  await add.getByRole("button", { name: "Add child" }).click();

  const tab = page.getByRole("tab", { name: `Smoke Child ${f.tag}` });
  await expect(tab).toBeVisible();
  await tab.click();
  const panel = page.getByRole("region", { name: `Acting for Smoke Child ${f.tag}` });
  await expect(panel).toBeVisible();
  await panel.getByLabel("Report file").setInputFiles(f.samplePdf);
  await panel.getByLabel("Title").fill(`Child report ${f.tag}`);
  await panel.getByRole("button", { name: "Upload" }).click();
  await expect(panel.getByRole("status")).toContainText("Uploaded");

  // Read by the worker (mock OCR and extraction), then ready for the parent to check.
  await expect(async () => {
    await page.getByRole("tab", { name: "Me" }).click();
    await tab.click();
    await expect(panel.getByRole("button", { name: "Confirm the clear ones" })).toBeEnabled({ timeout: 2_000 });
  }).toPass({ timeout: 90_000 });
  await panel.getByRole("button", { name: "Confirm the clear ones" }).click();
  await expect(panel.getByRole("status")).toContainText("confirmed by you (by proxy)");
});
