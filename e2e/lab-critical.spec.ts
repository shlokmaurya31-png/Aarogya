import { expect, test } from "@playwright/test";
import { fixture, signIn } from "./fixture";
import { hospitalStep } from "./steps";

/**
 * Week 5 final — a lab test with a critical result: the doctor orders it from
 * the chart; the lab collects, receives and accepts the specimen, releases a
 * critical result and verifies it; it appears as an unacknowledged critical
 * result, and the doctor acknowledges it from the chart.
 */
test("lab: order → specimen → critical result → verified → the doctor acknowledges it", async ({ browser }) => {
  const f = fixture();
  const test = `Potassium ${f.tag}`;
  const doctor = await (await browser.newContext()).newPage();
  await signIn(doctor, "/login", f.doctor.email, f.password);
  await doctor.waitForURL((u) => !u.pathname.startsWith("/login"));
  const { encounterId } = hospitalStep<{ encounterId: string }>("encounter", f.patient.patientId);
  const chart = `/hospital-os/doctor/patients/${f.patient.patientId}?encounterId=${encounterId}`;
  await doctor.goto(chart);
  const order = doctor.getByPlaceholder("Test name (e.g. CBC, Troponin I)");
  await order.fill(test);
  await order.locator("xpath=..").getByRole("button", { name: "Order" }).click();
  await expect(doctor.getByText(test).first()).toBeVisible();

  const lab = await (await browser.newContext()).newPage();
  await signIn(lab, "/login", f.labTech.email, f.password);
  await lab.waitForURL((u) => !u.pathname.startsWith("/login"));
  await lab.goto("/hospital-os/lab");
  const row = () => lab.locator("div").filter({ hasText: test }).filter({ has: lab.getByRole("button") }).last();
  for (const action of ["Collect", "Receive", "Accept"]) {
    await row().getByRole("button", { name: action, exact: true }).click();
    await expect(lab.getByText(new RegExp(`Specimen ${action === "Collect" ? "collected" : action === "Receive" ? "received" : "accepted"}`)).first()).toBeVisible();
  }
  await row().getByRole("button", { name: "Enter result" }).click();
  await lab.getByPlaceholder("Value", { exact: true }).fill("6.9");
  await lab.getByPlaceholder("Unit", { exact: true }).fill("mmol/L");
  await lab.getByLabel("Critical").check();
  await lab.getByRole("button", { name: "Release result" }).click();
  await expect(lab.getByText("Result entered.").first()).toBeVisible();
  await row().getByRole("button", { name: "Verify", exact: true }).click();
  await expect(lab.getByText("Result verified.").first()).toBeVisible();
  // The lab's worklist now lists it among unacknowledged critical results, with its Acknowledge action.
  const critical = () => lab.locator("div").filter({ hasText: test }).filter({ has: lab.getByRole("button", { name: "Acknowledge", exact: true }) });
  await expect(critical().last()).toBeVisible();

  await doctor.goto(chart);
  await doctor.getByRole("button", { name: "Acknowledge critical result" }).first().click();
  await expect(doctor.getByRole("button", { name: "Acknowledge critical result" })).toHaveCount(0);
  await lab.reload();
  await expect(lab.getByText(test)).toHaveCount(0);
  await expect(critical()).toHaveCount(0);
});
