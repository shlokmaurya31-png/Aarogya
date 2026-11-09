import { expect, test } from "@playwright/test";
import { fixture, signIn } from "./fixture";
import { hospitalStep } from "./steps";

/**
 * Flagship 4d — the ward tablet with the network cut (docs/OFFLINE_NURSING_DESIGN.md
 * §13.4): the nurse downloads her list; the network goes; she gives a dose,
 * records vitals and completes a task; meanwhile the charge nurse takes the
 * second dose over and gives it online, and the tablet, not knowing, records
 * it as given too. When the network is back the tablet syncs by itself: the
 * server has the dose at the time it was given, the vitals and the task, and
 * the double dose is in the charge nurse's queue.
 */
test("offline ward round: doses and vitals with the network cut, synced on reconnect; a double dose lands in the queue", async ({ page, context }) => {
  const f = fixture();
  const w = hospitalStep<{ name: string; patientId: string; encounterId: string; deviceId: string; drugName: string; d1: string; d2: string; dc: string; taskId: string; taskTitle: string }>("ward-device");
  await signIn(page, "/login", f.nurse.email, f.password);
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));

  // Set up the tablet and download the list (online).
  await page.goto("/ward");
  await page.getByLabel("Device code").fill(w.deviceId);
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "Download my list" }).click();
  const patient = page.getByRole("region", { name: w.name });
  await expect(patient).toBeVisible();
  await expect(page.getByTestId(`dose-${w.dc}`)).toContainText("Online only");

  // The network goes.
  await context.setOffline(true);
  await expect(page.getByRole("status")).toContainText("Offline since");
  const givenAt = Date.now();
  await page.getByTestId(`dose-${w.d1}`).getByRole("button", { name: "Given" }).click();
  await expect(page.getByTestId(`dose-${w.d1}`)).toContainText("waiting to sync");
  await patient.getByRole("button", { name: "Record vitals" }).click();
  await patient.getByLabel("HR", { exact: true }).fill("88");
  await patient.getByLabel("SBP").fill("124");
  await patient.getByLabel("SpO2").fill("97");
  await patient.getByRole("button", { name: "Save vitals" }).click();
  await patient.getByRole("button", { name: "Done" }).click();

  // Meanwhile, online: the charge nurse takes the second dose over and gives it. The tablet doesn't know.
  hospitalStep("take-over-give", w.d2);
  await page.getByTestId(`dose-${w.d2}`).getByRole("button", { name: "Given" }).click();
  await expect(page.getByText("4 waiting to sync")).toBeVisible();

  // The network is back: the tablet syncs by itself.
  await context.setOffline(false);
  await expect(page.getByText(/Everything is synced/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/for the charge nurse to review/)).toBeVisible();

  await expect(async () => {
    const s = hospitalStep<{ d1: { status: string; administeredAt: string | null }; d2Given: number; vitals: (number | null)[]; task: string; conflicts: { kind: string; severity: string; status: string }[] }>("ward-state", JSON.stringify(w));
    expect(s.d1.status).toBe("GIVEN");
    // Recorded at the time it was given on the tablet, not when it synced.
    expect(Math.abs(Date.parse(s.d1.administeredAt!) - givenAt)).toBeLessThan(60_000);
    expect(s.vitals).toContain(88);
    expect(s.task).toBe("COMPLETED");
    expect(s.d2Given).toBe(2);
    expect(s.conflicts).toContainEqual({ kind: "POSSIBLE_DOUBLE_DOSE", severity: "CRITICAL", status: "OPEN" });
  }).toPass({ timeout: 30_000 });

  // The double dose is in the charge nurse's queue.
  await page.goto("/hospital-os/nurse/offline-queue");
  const item = page.getByTestId("conflict-POSSIBLE_DOUBLE_DOSE").filter({ hasText: w.name });
  await expect(item).toBeVisible();
  await expect(item).toContainText(w.drugName);
});
