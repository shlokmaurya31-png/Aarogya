import { expect, test } from "@playwright/test";
import { fixture, signIn } from "./fixture";
import { hospitalStep } from "./steps";

/**
 * Flagship 6 — Scan and Share with the mock ABDM gateway: the patient scans
 * the counter's QR, confirms their ABHA address and shares their profile; they
 * get a token, with no form to fill. The desk sees the token in the check-in
 * queue and registers them from the shared profile.
 */
test("scan and share: the patient scans the counter QR, gets a token; the desk registers them from the profile", async ({ browser }) => {
  const f = fixture();
  const counter = hospitalStep<{ path: string; label: string }>("scan-counter");

  const patientCtx = await browser.newContext();
  const patient = await patientCtx.newPage();
  await signIn(patient, "/patient/login", f.patient.email, f.password);
  await patient.waitForURL((u) => u.pathname === "/patient");
  await patient.goto(counter.path);
  await expect(patient.getByText(counter.label)).toBeVisible();
  await patient.getByLabel("ABHA address").fill(`e2e${f.tag}${Date.now().toString(36)}@sbx`);
  await patient.getByRole("button", { name: "Share and get my token" }).click();
  const tokenEl = patient.getByLabel("Your token");
  await expect(tokenEl).toHaveText(/^S-\d{3}$/);
  const token = (await tokenEl.textContent())!.trim();

  const deskCtx = await browser.newContext();
  const desk = await deskCtx.newPage();
  await signIn(desk, "/login", f.frontDesk.email, f.password);
  await desk.waitForURL((u) => !u.pathname.startsWith("/login"));
  await desk.goto("/hospital-os/front-desk");
  const row = desk.getByTestId(`scan-${token}`);
  await expect(row).toBeVisible();
  await expect(row).toContainText(f.patient.name);
  await row.getByRole("button", { name: "Register and queue" }).click();
  await expect(desk.getByText("Registered from the shared profile and queued.")).toBeVisible();
  await expect(desk.getByTestId(`scan-${token}`)).toContainText("In the queue");
  await patientCtx.close();
  await deskCtx.close();
});
