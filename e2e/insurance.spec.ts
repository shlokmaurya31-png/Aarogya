import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { fixture, signIn } from "./fixture";

/** The hospital's side, through the real services (scripts/lib/e2eInsuranceSteps.ts). */
function hospital(step: "bill" | "webhook" | "settle") {
  const r = spawnSync(path.join(process.cwd(), "node_modules", ".bin", "tsx"), ["scripts/lib/e2eInsuranceSteps.ts", step], { cwd: process.cwd(), env: process.env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`hospital step ${step} failed:\n${r.stdout}\n${r.stderr}`);
}

/**
 * Week 5c — a patient with insurance, in the browser: adds their card → checks
 * in before the visit with it (a token; eligibility pending) → the desk sees
 * them pre-registered, verifies the card and marks them ready and arrived →
 * the visit ends in an admission and discharge → the itemised bill with the
 * cashless amount and their share → they pay their share to the hospital's
 * gateway (test mode; confirmed by the gateway's signed webhook) → the claim
 * goes from submitted to settled.
 */
test("insurance: card → pre-arrival check-in → desk → discharge → bill → pay share → claim settled", async ({ browser }) => {
  const f = fixture();
  const member = `SMK${f.tag.toUpperCase().replace(/[^A-Z0-9]/g, "")}9Q4W`;
  const patient = await (await browser.newContext()).newPage();
  await signIn(patient, "/patient/login", f.patient.email, f.password);
  await patient.waitForURL((u) => u.pathname === "/patient");

  // The card.
  await patient.goto("/patient/insurance");
  await patient.getByRole("button", { name: "Add a card" }).click();
  const add = patient.getByRole("region", { name: "Add a card" });
  await add.getByLabel("Insurer").fill(`Smoke Health ${f.tag}`);
  await add.getByLabel("Member number").fill(member);
  await add.getByRole("button", { name: "Save card" }).click();
  await expect(patient.getByRole("list", { name: "Cards" }).getByText(`••••${member.slice(-4)}`)).toBeVisible();
  await expect(patient.getByText(member)).toHaveCount(0);

  // Pre-arrival check-in.
  await patient.goto("/patient/appointments");
  await patient.getByRole("link", { name: "Check in" }).first().click();
  await patient.waitForURL((u) => u.pathname === "/patient/checkin");
  await patient.getByLabel("These are right").check();
  await patient.getByLabel("Insurance").selectOption({ label: `Smoke Health ${f.tag} · Health insurance · ••••${member.slice(-4)}` });
  await patient.getByRole("button", { name: "Check in and get my token" }).click();
  const mine = patient.getByRole("region", { name: "Your check-in" });
  await expect(mine.getByText(/Eligibility pending/)).toBeVisible();
  const token = (await mine.getByLabel("Token").textContent())!.trim();
  expect(token).toMatch(/^P-\d{3}$/);

  // The desk.
  const desk = await (await browser.newContext()).newPage();
  await signIn(desk, "/login", f.desk.email, f.password);
  await desk.waitForURL((u) => !u.pathname.startsWith("/login"));
  await desk.goto("/hospital-os/front-desk");
  const row = desk.getByRole("list", { name: "Pre-registered" }).getByRole("listitem").filter({ hasText: token });
  await expect(row.getByText("PRE-REGISTERED")).toBeVisible();
  await expect(row.getByText(/Eligibility pending/)).toBeVisible();
  await row.getByRole("button", { name: "Check the card" }).click();
  await expect(row.getByText(`member ${member}`)).toBeVisible();
  await row.getByLabel("Payer").selectOption({ index: 1 });
  await row.getByRole("button", { name: "Verified" }).click();
  await expect(row.getByText(/Card verified/)).toBeVisible();
  await row.getByRole("button", { name: "Ready" }).click();
  await expect(row.getByText("READY", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "Arrived" }).click();
  await expect(row.getByText("ARRIVED", { exact: true })).toBeVisible();

  // Discharge and the itemised bill (the worker drafts the claim).
  hospital("bill");
  await patient.goto("/patient/insurance");
  await expect(patient.getByLabel("Cashless").first()).toContainText("Cashless approved");
  const bill = patient.getByRole("table", { name: "Itemised bill" }).first();
  await expect(bill.getByText("Surgery")).toBeVisible();
  await expect(patient.getByLabel("Your share").first()).toContainText("Your share: ₹1,200");
  // The worker drafts the claim from the issued bill (claim-drafting); the page shows it once reloaded.
  await expect(async () => {
    await patient.reload();
    await expect(patient.getByLabel("Claim").first()).toContainText("preparing your claim", { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });

  // Pay the share to the hospital's gateway (test mode).
  await patient.getByRole("button", { name: /Pay your share ₹1,200/ }).click();
  await expect(patient.getByText(/Test payment started/)).toBeVisible();
  hospital("webhook");
  await expect(patient.getByText("Paid. The hospital has received your payment.")).toBeVisible();

  // The claim, submitted to settled.
  hospital("settle");
  await patient.reload();
  const claim = patient.getByLabel("Claim").first();
  await expect(claim).toContainText("Your insurer has paid the hospital");
  await expect(claim.getByText("✓ Your insurer paid the hospital")).toBeVisible();
});
