import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { fixture, signIn } from "./fixture";

/**
 * RAG Phase 2 — knowledge documents: the hospital administrator uploads an
 * SOP and sees it processed and waiting; the medical superintendent approves
 * it (a second person) and it is published; the administrator uploads a new
 * version, which supersedes the first once approved. Both screens pass WCAG
 * 2.2 AA (axe). A file naming a patient is refused with nothing kept.
 */
const WCAG_22_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function axe(page: Page, who: string) {
  const r = await new AxeBuilder({ page }).include("main").withTags(WCAG_22_AA).analyze();
  expect(r.violations.map((v) => `${who}: ${v.id} (${v.impact}) ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`), "WCAG 2.2 AA").toEqual([]);
}

async function uploadFile(page: Page, name: string, text: string, title?: string) {
  const form = page.getByRole("form", { name: "Upload a knowledge document" });
  await form.getByLabel(/^File/).setInputFiles({ name, mimeType: "text/markdown", buffer: Buffer.from(text, "utf8") });
  if (title) await form.getByLabel("Title").fill(title);
  await form.getByRole("button", { name: "Upload", exact: true }).click();
}

test("knowledge documents: upload, approve by a second person, supersede; identifiers refused; axe on both screens", async ({ browser }) => {
  test.setTimeout(180_000);
  const f = fixture();
  const title = `Oxygen cylinder SOP ${f.tag}`;

  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await signIn(admin, "/login", f.desk.email, f.password);
  await admin.waitForURL((u) => !u.pathname.startsWith("/login"));
  await admin.goto("/hospital-os/knowledge");
  await expect(admin.getByRole("heading", { name: "Knowledge documents" })).toBeVisible();
  await axe(admin, "admin, before uploading");

  // A file that names a patient is refused, with nothing kept.
  await uploadFile(admin, `case-${f.tag}.md`, "# Case\n\nMr. Ramesh Kumar, 45 years, phone 9876543210.\n", `Case example ${f.tag}`);
  await expect(admin.getByText(/looks like it contains patient identifiers/)).toBeVisible();
  await expect(admin.getByRole("listitem", { name: `Document Case example ${f.tag}` })).toHaveCount(0);

  await uploadFile(admin, `oxygen-${f.tag}.md`, `# Oxygen cylinders\n\nCheck the gauge every shift; replace below 500 psi.\n`, title);
  const doc = admin.getByRole("listitem", { name: `Document ${title}` });
  await expect(doc).toBeVisible();
  // The worker ingests it; the screen refreshes itself while processing.
  await expect(doc.getByRole("row", { name: `Version 1 of ${title}` }).getByText("Awaiting approval")).toBeVisible({ timeout: 60_000 });
  await expect(doc.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await axe(admin, "admin, a document waiting");

  const superCtx = await browser.newContext();
  const sup = await superCtx.newPage();
  await signIn(sup, "/login", f.superintendent.email, f.password);
  await sup.waitForURL((u) => u.pathname.startsWith("/hospital-os/knowledge"));
  const supDoc = sup.getByRole("listitem", { name: `Document ${title}` });
  await expect(supDoc).toBeVisible();
  await expect(sup.getByRole("form", { name: "Upload a knowledge document" })).toHaveCount(0);
  await axe(sup, "superintendent");
  await supDoc.getByRole("button", { name: "Approve" }).click();
  await expect(sup.getByText("Approved and published.")).toBeVisible();
  await expect(supDoc.getByRole("row", { name: `Version 1 of ${title}` }).getByText("Published")).toBeVisible();

  // A new version supersedes the first once approved.
  await admin.reload();
  await doc.getByRole("button", { name: "Upload a new version…" }).click();
  await uploadFile(admin, `oxygen-v2-${f.tag}.md`, `# Oxygen cylinders\n\nCheck the gauge every shift; replace below 400 psi.\n`);
  await expect(doc.getByRole("row", { name: `Version 2 of ${title}` }).getByText("Awaiting approval")).toBeVisible({ timeout: 60_000 });
  await sup.reload();
  await supDoc.getByRole("row", { name: `Version 2 of ${title}` }).getByRole("button", { name: "Approve" }).click();
  await expect(supDoc.getByRole("row", { name: `Version 2 of ${title}` }).getByText("Published")).toBeVisible();
  await expect(supDoc.getByRole("row", { name: `Version 1 of ${title}` }).getByText("Superseded")).toBeVisible();
  await axe(sup, "superintendent, superseded");

  await adminCtx.close();
  await superCtx.close();
});
