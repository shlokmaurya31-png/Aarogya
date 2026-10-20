import { expect, test } from "@playwright/test";
import { fixture, signIn } from "./fixture";

/**
 * Week 5a — the doctor network's journey in the browser: the patient searches
 * by symptom, books the verified doctor with a record share for the visit,
 * then the doctor opens the booking's visit brief and sees the shared
 * hemoglobin result cited and labelled.
 */
test("directory: search → book with a share → the doctor sees the brief", async ({ browser }) => {
  const f = fixture();
  const patient = await browser.newPage();
  await signIn(patient, "/patient/login", f.patient.email, f.password);
  await patient.waitForURL((u) => u.pathname === "/patient");
  await patient.goto("/patient/doctors");
  await patient.getByLabel("Symptom").selectOption("FEVER");
  await patient.getByRole("button", { name: "Search" }).click();
  const doctors = patient.getByRole("list", { name: "Doctors" });
  const card = doctors.locator("li").filter({ hasText: f.networkDoctor.name });
  await expect(card).toBeVisible();
  await expect(card.getByText(/Registered since 2008/)).toBeVisible();
  await card.getByRole("button", { name: "Book here" }).click();
  const times = card.getByRole("radiogroup", { name: "Times" });
  await expect(times.getByRole("radio").first()).toBeVisible();
  await times.getByRole("radio").first().click();
  await expect(card.getByText(/Share my record with/)).toBeVisible();
  await card.getByRole("button", { name: "Book", exact: true }).click();
  await expect(patient.getByRole("status")).toContainText("your record is shared for this visit");
  await patient.close();

  const doctor = await browser.newPage();
  await signIn(doctor, "/login", f.networkDoctor.email, f.password);
  await doctor.waitForURL((u) => !u.pathname.startsWith("/login"));
  await doctor.goto("/hospital-os/doctor/bookings");
  const row = doctor.getByRole("list", { name: "Directory bookings" }).locator("li").filter({ hasText: f.patient.name });
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: "Open visit brief" }).click();
  const ai = doctor.getByRole("region", { name: "Visit brief from the shared record (cited, advisory)" });
  await expect(ai).toBeVisible();
  await ai.getByRole("tab", { name: "Visit brief" }).click();
  await ai.getByRole("button", { name: "Generate" }).click();
  const hb = ai.locator("ol li").filter({ hasText: "10.4" });
  await expect(hb.first()).toBeVisible();
  await expect(hb.first().getByText("verified", { exact: true })).toBeVisible();
});
