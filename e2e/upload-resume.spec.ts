import { createHash, randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { fixture, signIn } from "./fixture";
import { hospitalStep } from "./steps";

/**
 * Flagship 5, step 6c — an upload on a dropping connection: a 1.2 MB report
 * goes in 256 KB pieces; the network is cut while the third is on its way;
 * the screen says the connection was lost and how far it got; when the
 * network is back it carries on from what arrived, and the stored file is
 * byte for byte the one chosen.
 */
test("upload: the network drops mid-upload and it resumes; the stored file is exactly the one sent", async ({ page, context }) => {
  const f = fixture();
  const title = `Resumed report ${f.tag}`;
  const file = Buffer.concat([Buffer.from("%PDF-1.4\n% synthetic report for the upload journey\n"), randomBytes(1_200_000), Buffer.from("\n%%EOF\n")]);
  await signIn(page, "/patient/login", f.patient.email, f.password);
  await page.waitForURL((u) => u.pathname === "/patient");
  await page.goto("/patient/documents");

  let pieces = 0;
  await page.route(/\/api\/patient\/uploads\/[^/]+\?offset=/, async (route) => {
    pieces += 1;
    if (pieces === 3) {
      await context.setOffline(true);
      await route.abort("internetdisconnected");
      return;
    }
    await route.continue();
  });

  await page.getByLabel("Report file").setInputFiles({ name: "report.pdf", mimeType: "application/pdf", buffer: file });
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Upload" }).click();
  const status = page.getByRole("form", { name: "Add a report" }).getByRole("status");
  await expect(status).toContainText("Connection lost at");
  const progress = page.getByRole("progressbar", { name: "Upload progress" });
  const at = Number(await progress.getAttribute("aria-valuenow"));
  expect(at, "progress kept while offline").toBeGreaterThan(0);
  expect(at).toBeLessThan(100);

  await context.setOffline(false);
  await expect(status).toHaveText("Uploaded.", { timeout: 60_000 });
  await expect(progress).toHaveAttribute("aria-valuenow", "100");
  await expect(page.getByText(title)).toBeVisible();
  expect(pieces, "it carried on with the remaining pieces").toBeGreaterThanOrEqual(5);
  expect(hospitalStep<{ sha256: string }>("upload-sha", title).sha256).toBe(createHash("sha256").update(file).digest("hex"));
});
