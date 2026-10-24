import { expect, test } from "@playwright/test";
import { fixture, signIn } from "./fixture";

/**
 * Week 5 final — an OPD visit: the front desk registers a new patient, finds
 * them, books them with the doctor today and checks them in; the doctor opens
 * the chart, records a diagnosis, signs a note and orders a medicine.
 */
test("OPD visit: register → book → check in → the doctor's diagnosis, note and prescription", async ({ browser }) => {
  const f = fixture();
  const name = `OPD Smoke ${f.tag}`;
  const desk = await (await browser.newContext()).newPage();
  await signIn(desk, "/login", f.frontDesk.email, f.password);
  await desk.waitForURL((u) => !u.pathname.startsWith("/login"));
  await desk.goto("/hospital-os/front-desk");

  await desk.getByRole("button", { name: "New patient" }).click();
  await desk.getByPlaceholder("Full name").fill(name);
  await desk.getByPlaceholder("Age (years)").fill("45");
  await desk.getByPlaceholder("Phone", { exact: true }).fill(`98${String(Date.now()).slice(-8)}`);
  const registered = desk.waitForResponse((r) => r.url().endsWith("/api/hospital/patients") && r.request().method() === "POST");
  await desk.getByRole("button", { name: "Register patient" }).click();
  const reg = await registered;
  expect(reg.ok(), await reg.text()).toBe(true);
  // Registering selects the new patient for booking.
  await expect(desk.getByText(`Registered ${name}`).first()).toBeVisible();
  await expect(desk.getByText("Booking for selected patient above.").first()).toBeVisible();
  await desk.locator("select").filter({ hasText: "Select doctor..." }).selectOption({ label: `${f.doctor.name} — Physician` });
  await desk.getByPlaceholder("Reason for visit").fill("Cough for a week");
  const slot = desk.locator("button").filter({ hasText: /^\d{1,2}:\d{2}/ }).first();
  await expect(slot).toBeVisible();
  await slot.click();
  await expect(desk.getByText("Appointment booked.").first()).toBeVisible();

  const today = desk.locator("div.rounded-lg").filter({ hasText: name }).filter({ has: desk.getByRole("button", { name: "Check in" }) }).first();
  await today.getByRole("button", { name: "Check in" }).click();
  await expect(desk.getByText("Patient checked in.").first()).toBeVisible();

  const doctor = await (await browser.newContext()).newPage();
  await signIn(doctor, "/login", f.doctor.email, f.password);
  await doctor.waitForURL((u) => !u.pathname.startsWith("/login"));
  // The checked-in visit is in the doctor's active encounters; opening it opens the chart for that encounter.
  await doctor.goto("/hospital-os/doctor");
  await doctor.getByRole("link", { name: new RegExp(name) }).first().click();
  await doctor.waitForURL((u) => u.pathname.startsWith("/hospital-os/doctor/patients/") && u.searchParams.has("encounterId"));
  await expect(doctor.getByText(name).first()).toBeVisible();

  await doctor.getByRole("button", { name: "Diagnoses & Problems" }).click();
  const dx = doctor.getByPlaceholder("Diagnosis");
  await dx.fill("Acute bronchitis");
  await dx.locator("xpath=..").getByRole("button", { name: "Add" }).click();
  await expect(doctor.getByText("Acute bronchitis").nth(0)).toBeVisible();

  await doctor.getByRole("button", { name: "Notes", exact: true }).click();
  await doctor.getByPlaceholder("Assessment / plan...").fill(`Viral bronchitis; fluids and rest (${f.tag}).`);
  await doctor.getByRole("button", { name: "Sign & save note" }).click();
  await expect(doctor.getByText(`Viral bronchitis; fluids and rest (${f.tag}).`)).toBeVisible();

  await doctor.getByRole("button", { name: "Orders", exact: true }).click();
  await doctor.getByPlaceholder("Drug").fill("Paracetamol");
  await doctor.getByPlaceholder("Dose").fill("500 mg");
  await doctor.getByPlaceholder("Route").fill("PO");
  await doctor.getByPlaceholder("Frequency").fill("TDS");
  const placed = doctor.waitForResponse((r) => r.url().endsWith("/api/hospital/orders/medication") && r.request().method() === "POST");
  await doctor.getByRole("button", { name: "Place order" }).click();
  const placedRes = await placed;
  expect(placedRes.status(), await placedRes.text()).toBeLessThan(400);
  // The safety check may ask for a reason first (allergy status unknown); the doctor gives one.
  const ordered = doctor.getByText(/Medication ordered\.|safety flag\(s\) noted/).first();
  const override = doctor.getByPlaceholder("Override reason (required to proceed)");
  await expect(ordered.or(override)).toBeVisible();
  if (await override.isVisible()) {
    await override.fill("Allergy history taken verbally: none known");
    await doctor.getByRole("button", { name: "Override & order" }).click();
  }
  await expect(ordered).toBeVisible();
});
