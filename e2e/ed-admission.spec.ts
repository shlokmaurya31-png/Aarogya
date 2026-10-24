import { expect, test } from "@playwright/test";
import { fixture, signIn } from "./fixture";
import { hospitalStep } from "./steps";

/**
 * Week 5 final — ED → admission → ICU → OT → discharge → invoice → claim
 * draft: a patient arrives in the ED; the doctor triages them on the board
 * and admits them to a ward bed (the disposition, through ADT); they move to
 * the ICU and have a procedure in theatre; the admin discharges them; the
 * final bill is issued and the worker drafts the insurance claim.
 */
test("ED → admission → ICU → OT → discharge → invoice → claim draft", async ({ browser }) => {
  const f = fixture();
  const ed = hospitalStep<{ name: string; patientId: string; encounterId: string; bedId: string }>("ed-arrival");
  hospitalStep("coverage", ed.patientId);

  const doctor = await (await browser.newContext()).newPage();
  await signIn(doctor, "/login", f.doctor.email, f.password);
  await doctor.waitForURL((u) => !u.pathname.startsWith("/login"));
  await doctor.goto("/hospital-os/ed");
  await doctor.getByPlaceholder("Search name / UHID / complaint").fill(ed.name);
  const card = doctor.locator("div").filter({ hasText: ed.name }).filter({ has: doctor.getByRole("button", { name: "Triage" }) }).last();
  await card.getByRole("button", { name: "Triage" }).click();
  await doctor.getByLabel("Acuity").selectOption("2");
  await doctor.getByRole("button", { name: "Record triage" }).click();
  await expect(doctor.getByText("Triage recorded.").first()).toBeVisible();

  await doctor.goto(`/hospital-os/ed/${ed.encounterId}`);
  await doctor.getByRole("button", { name: /Disposition/ }).first().click();
  await doctor.locator("select").filter({ hasText: "ADMIT WARD" }).selectOption({ label: "ADMIT WARD" });
  await doctor.getByPlaceholder("Destination bed ID").fill(ed.bedId);
  await doctor.getByPlaceholder("Reason / note").fill("Unstable angina");
  await doctor.getByRole("button", { name: "Record disposition" }).click();
  await expect(doctor.getByText("Disposition recorded.").first()).toBeVisible();

  const admin = await (await browser.newContext()).newPage();
  await signIn(admin, "/login", f.desk.email, f.password);
  await admin.waitForURL((u) => !u.pathname.startsWith("/login"));
  await admin.goto("/hospital-os/admissions");
  await expect(admin.getByText(ed.name).first()).toBeVisible();

  const icuOt = hospitalStep<{ icuBed: string }>("icu-ot", ed.encounterId);
  await admin.goto("/hospital-os/icu");
  await expect(admin.getByText(ed.name).first()).toBeVisible();

  await admin.goto("/hospital-os/discharge");
  // The patient's own admission card (one per admission on the discharge board).
  const dc = admin.locator('div[class*="rounded-[20px]"]').filter({ hasText: ed.name });
  const initiated = admin.waitForResponse((r) => /\/api\/hospital\/admissions\/[^/]+\/discharge$/.test(r.url()) && r.request().method() === "POST");
  await dc.getByRole("button", { name: "Initiate discharge" }).click();
  const ini = await initiated;
  expect(ini.ok(), await ini.text()).toBe(true);
  await expect(dc.getByRole("button", { name: "Finalize discharge" })).toBeVisible();
  // Each readiness flag is saved, then the board reloads it.
  for (const label of ["Clinically ready", "Documentation", "Billing", "Insurance", "Pharmacy", "Transport"]) {
    const box = dc.getByRole("checkbox", { name: label });
    if (!(await box.isChecked())) {
      const saved = admin.waitForResponse((r) => r.url().includes("/discharge") && r.request().method() === "PATCH");
      await box.click();
      const res = await saved;
      expect(res.ok(), await res.text()).toBe(true);
      await expect(box).toBeChecked();
    }
  }
  const finalized = admin.waitForResponse((r) => r.url().endsWith("/discharge/finalize"));
  await dc.getByRole("button", { name: "Finalize discharge" }).click();
  const fin = await finalized;
  expect(fin.ok(), await fin.text()).toBe(true);
  await expect(admin.getByText(/Patient discharged/).first()).toBeVisible();
  void icuOt;

  const bill = hospitalStep<{ invoiceNumber: string }>("invoice", ed.encounterId);
  await expect(async () => {
    await admin.goto("/hospital-os/claims");
    await expect(admin.getByText(`Invoice ${bill.invoiceNumber}`).first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await expect(admin.locator("button").filter({ hasText: `Invoice ${bill.invoiceNumber}` }).getByText("DRAFT").first()).toBeVisible();
});
