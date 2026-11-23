/**
 * RAG Phase 2, step 2.2 — the knowledge routes by role, over HTTP against a
 * production build (docs/RAG_IMPLEMENTATION_PLAN.md §4.1, §13.3 A).
 *
 *   1. Each route by role: a hospital administrator lists, uploads, withdraws
 *      and re-runs but never approves; a medical superintendent and a quality
 *      lead list, approve and reject but never upload; a doctor and a nurse get
 *      none of it.
 *   2. Two people publish: the uploader can't approve (permission), and an
 *      approver at the same facility can; the list says PUBLISHED.
 *   3. Another facility's document is a 404 on every version route, and never
 *      in its list.
 *   4. Uploads refused with a code and nothing kept: a patient identifier
 *      (the kinds named, no value echoed), DOCX (asks for a PDF), bytes that
 *      disagree with the type.
 *   5. No response carries a hash, a storage reference or file contents.
 *
 * Usage: through `npm run verify:all` (builds unless --no-build).
 */
import "./lib/gateBootstrap";
import type { ChildProcess } from "node:child_process";
import { prisma } from "../src/lib/db";
import { ingestKnowledgeVersion } from "../src/lib/knowledge/ingest";
import { startServer, loginAs } from "./lib/appServer";
import { GATE_PASSWORD, NOIDA, PUNE, staffUser } from "./lib/knowledgeGate";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const tag = Date.now().toString(36);

async function main() {
  const people = {
    admin: await staffUser(`ka-admin-${tag}@verify.aarogya`, "HOSPITAL_ADMIN", PUNE),
    superintendent: await staffUser(`ka-super-${tag}@verify.aarogya`, "MEDICAL_SUPERINTENDENT", PUNE),
    quality: await staffUser(`ka-quality-${tag}@verify.aarogya`, "QUALITY_LEAD", PUNE),
    doctor: await staffUser(`ka-doctor-${tag}@verify.aarogya`, "DOCTOR", PUNE),
    nurse: await staffUser(`ka-nurse-${tag}@verify.aarogya`, "NURSE", PUNE),
    noidaAdmin: await staffUser(`ka-noida-admin-${tag}@verify.aarogya`, "HOSPITAL_ADMIN", NOIDA),
    noidaSuper: await staffUser(`ka-noida-super-${tag}@verify.aarogya`, "MEDICAL_SUPERINTENDENT", NOIDA),
  };
  let server: { base: string; child: ChildProcess; serverLog: () => string } | null = null;
  try {
    server = await startServer();
    const { base } = server;
    const cookie: Record<keyof typeof people, string> = {} as never;
    for (const k of Object.keys(people) as (keyof typeof people)[]) cookie[k] = await loginAs(base, people[k].email, GATE_PASSWORD);
    const bodies: string[] = [];
    const call = async (who: keyof typeof people, method: string, p: string, body?: unknown) => {
      const r = await fetch(base + p, { method, headers: { cookie: cookie[who], ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}) }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
      const text = await r.text();
      bodies.push(text);
      let json: Record<string, unknown> = {};
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: r.status, json, text };
    };
    const form = (name: string, type: string, text: string | Buffer, extra: Record<string, string> = {}) => {
      const f = new FormData();
      f.set("file", new Blob([new Uint8Array(typeof text === "string" ? Buffer.from(text, "utf8") : text)], { type }), name);
      for (const [k, v] of Object.entries({ title: `Oxygen SOP ${tag}`, documentType: "SOP", accessClass: "CLINICAL", ...extra })) f.set(k, v);
      return f;
    };
    const sop = `# Oxygen cylinders\n\nCheck the gauge every shift; replace below 500 psi. Ref ${tag}.\n`;

    // ── 1. Each route by role ──
    for (const who of ["admin", "superintendent", "quality"] as const) report(`List: ${who} 200`, (await call(who, "GET", "/api/hospital/knowledge")).status === 200);
    for (const who of ["doctor", "nurse"] as const) report(`List: ${who} 403`, (await call(who, "GET", "/api/hospital/knowledge")).status === 403);
    for (const who of ["superintendent", "quality", "doctor", "nurse"] as const) report(`Upload: ${who} 403`, (await call(who, "POST", "/api/hospital/knowledge", form(`a-${tag}.md`, "text/markdown", sop))).status === 403);
    const up = await call("admin", "POST", "/api/hospital/knowledge", form(`oxygen-${tag}.md`, "text/markdown", sop));
    const versionId = String((up.json.version as { id?: string } | undefined)?.id ?? "");
    report("Upload: hospital administrator 200, the version PROCESSING", up.status === 200 && !!versionId && (up.json.version as { state?: string }).state === "PROCESSING", `${up.status} ${up.text.slice(0, 120)}`);
    await ingestKnowledgeVersion(versionId);

    // ── 2. Two people publish ──
    const selfApprove = await call("admin", "POST", `/api/hospital/knowledge/versions/${versionId}/approve`, {});
    report("Approve: the uploader (hospital administrator) is refused 403", selfApprove.status === 403);
    for (const who of ["doctor", "nurse"] as const) report(`Approve: ${who} 403`, (await call(who, "POST", `/api/hospital/knowledge/versions/${versionId}/approve`, {})).status === 403);
    for (const who of ["superintendent", "quality", "doctor"] as const) report(`Withdraw: ${who} 403`, (await call(who, "POST", `/api/hospital/knowledge/versions/${versionId}/withdraw`, { reason: "no" })).status === 403);

    // ── 3. Another facility: 404 everywhere, never listed ──
    for (const [who, action] of [["noidaSuper", "approve"], ["noidaSuper", "reject"], ["noidaAdmin", "withdraw"], ["noidaAdmin", "retry"]] as const) {
      const r = await call(who, "POST", `/api/hospital/knowledge/versions/${versionId}/${action}`, { reason: "not ours at all" });
      report(`Another facility: ${action} is 404`, r.status === 404, String(r.status));
    }
    const noidaList = await call("noidaAdmin", "GET", "/api/hospital/knowledge");
    report("Another facility: never in its list", noidaList.status === 200 && !noidaList.text.includes(versionId) && !noidaList.text.includes(`Oxygen SOP ${tag}`));

    const approve = await call("superintendent", "POST", `/api/hospital/knowledge/versions/${versionId}/approve`, {});
    report("Approve: the medical superintendent approves; published", approve.status === 200 && approve.json.published === true, approve.text.slice(0, 120));
    const list = await call("quality", "GET", "/api/hospital/knowledge");
    const docs = list.json.documents as { title: string; versions: { id: string; state: string; uploadedByMe: boolean }[] }[];
    const mine = docs.find((d) => d.title === `Oxygen SOP ${tag}`);
    report("List: the version is PUBLISHED, uploaded by someone else", mine?.versions[0]?.state === "PUBLISHED" && mine.versions[0].uploadedByMe === false);
    report("List: the approver sees it can approve, not manage", list.json.canApprove === true && list.json.canManage === false);
    report("Approve: approving again is a 409", (await call("quality", "POST", `/api/hospital/knowledge/versions/${versionId}/approve`, {})).status === 409);

    // Reject and withdraw, with their reasons.
    const up2 = await call("admin", "POST", "/api/hospital/knowledge", form(`oxygen-v2-${tag}.md`, "text/markdown", sop.replace("500 psi", "400 psi"), { documentId: String((up.json.document as { id: string }).id) }));
    const v2 = String((up2.json.version as { id?: string } | undefined)?.id ?? "");
    report("Upload: a new version of the document", up2.status === 200 && (up2.json.version as { version?: number }).version === 2);
    await ingestKnowledgeVersion(v2);
    report("Reject: a reason is required", (await call("quality", "POST", `/api/hospital/knowledge/versions/${v2}/reject`, { reason: "" })).status === 400);
    report("Reject: the quality lead rejects with a reason", (await call("quality", "POST", `/api/hospital/knowledge/versions/${v2}/reject`, { reason: "The threshold is not agreed" })).status === 200);
    report("Re-run: only a failed version (409)", (await call("admin", "POST", `/api/hospital/knowledge/versions/${versionId}/retry`)).status === 409);
    report("Withdraw: the hospital administrator withdraws with a reason", (await call("admin", "POST", `/api/hospital/knowledge/versions/${versionId}/withdraw`, { reason: "Superseded by the gas pipeline" })).status === 200);

    // ── 3b. Plan §13.4 B: proposing an older version again ──
    for (const who of ["superintendent", "quality", "doctor", "nurse"] as const) report(`Re-propose: ${who} 403`, (await call(who, "POST", `/api/hospital/knowledge/versions/${versionId}/repropose`, {})).status === 403);
    report("Re-propose: another facility's administrator 404", (await call("noidaAdmin", "POST", `/api/hospital/knowledge/versions/${versionId}/repropose`, {})).status === 404);
    const rp = await call("admin", "POST", `/api/hospital/knowledge/versions/${versionId}/repropose`, {});
    const rpId = String((rp.json.version as { id?: string } | undefined)?.id ?? "");
    report("Re-propose: the hospital administrator proposes the withdrawn version again, as version 3", rp.status === 200 && (rp.json.version as { version?: number }).version === 3, rp.text.slice(0, 120));
    await ingestKnowledgeVersion(rpId);
    report("Re-propose: the proposer can't approve it (403)", (await call("admin", "POST", `/api/hospital/knowledge/versions/${rpId}/approve`, {})).status === 403);
    const rpList = await call("quality", "GET", "/api/hospital/knowledge");
    const rpVersion = (rpList.json.documents as { versions: { id: string; state: string; reproposedFrom: number | null }[] }[]).flatMap((d) => d.versions).find((v) => v.id === rpId);
    report("Re-propose: listed as awaiting approval, proposed again from version 1", rpVersion?.state === "AWAITING_APPROVAL" && rpVersion.reproposedFrom === 1);
    report("Re-propose: a second person approves it", (await call("quality", "POST", `/api/hospital/knowledge/versions/${rpId}/approve`, {})).json.published === true);

    // ── 3c. Plan §13.4 C: the published contact list, and highlights by HTTP ──
    const mobile = `97${String(Date.now() % 100000).padStart(5, "0")}444`;
    for (const who of ["superintendent", "quality"] as const) report(`Contacts: ${who} reads 200`, (await call(who, "GET", "/api/hospital/knowledge/contacts")).status === 200);
    for (const who of ["doctor", "nurse"] as const) report(`Contacts: ${who} reads 403`, (await call(who, "GET", "/api/hospital/knowledge/contacts")).status === 403);
    for (const who of ["superintendent", "quality", "doctor", "nurse"] as const) report(`Contacts: ${who} adds 403`, (await call(who, "POST", "/api/hospital/knowledge/contacts", { kind: "HELPLINE", label: "Helpline", number: mobile })).status === 403);
    const hl = await call("admin", "POST", "/api/hospital/knowledge", form(`helpline-${tag}.md`, "text/markdown", `# Helpline\n\nCall ${mobile} for oxygen supply. Ref ${tag}.\n`, { title: `Helpline SOP ${tag}` }));
    const hlId = String((hl.json.version as { id?: string } | undefined)?.id ?? "");
    report("Highlights: an unlisted mobile is accepted, not refused", hl.status === 200 && !!hlId, hl.text.slice(0, 120));
    await ingestKnowledgeVersion(hlId);
    const hlList = await call("superintendent", "GET", "/api/hospital/knowledge");
    const hlVersion = (hlList.json.documents as { versions: { id: string; highlights: { id: string; kind: string; excerpt: string }[] }[] }[]).flatMap((d) => d.versions).find((v) => v.id === hlId);
    report("Highlights: the approver's list shows it, masked to its last four digits", hlVersion?.highlights.length === 1 && hlVersion.highlights[0].kind === "MOBILE_NUMBER" && hlVersion.highlights[0].excerpt.includes(`[••••••${mobile.slice(-4)}]`) && !hlList.text.includes(mobile));
    const noAck = await call("superintendent", "POST", `/api/hospital/knowledge/versions/${hlId}/approve`, {});
    report("Highlights: approval without acknowledging it is 409 HIGHLIGHTS_NOT_ACKNOWLEDGED", noAck.status === 409 && noAck.json.code === "HIGHLIGHTS_NOT_ACKNOWLEDGED");
    const ack = await call("superintendent", "POST", `/api/hospital/knowledge/versions/${hlId}/approve`, { acknowledgedHighlightIds: hlVersion?.highlights.map((h) => h.id) });
    report("Highlights: approved once acknowledged", ack.status === 200 && ack.json.published === true, ack.text.slice(0, 120));
    const added = await call("admin", "POST", "/api/hospital/knowledge/contacts", { kind: "HELPLINE", label: `Oxygen helpline ${tag}`, number: mobile });
    const contactId = String((added.json.contact as { id?: string } | undefined)?.id ?? "");
    report("Contacts: the hospital administrator adds a number", added.status === 200 && !!contactId);
    report("Contacts: another facility can't see or remove it", !(await call("noidaAdmin", "GET", "/api/hospital/knowledge/contacts")).text.includes(contactId) && (await call("noidaAdmin", "DELETE", `/api/hospital/knowledge/contacts/${contactId}`)).status === 404);
    const hl2 = await call("admin", "POST", "/api/hospital/knowledge", form(`helpline2-${tag}.md`, "text/markdown", `# Helpline\n\nCall ${mobile} for oxygen. Version two. Ref ${tag}.\n`, { title: `Helpline SOP two ${tag}` }));
    const hl2Version = ((await call("admin", "GET", "/api/hospital/knowledge")).json.documents as { versions: { id: string; highlights: unknown[] }[] }[]).flatMap((d) => d.versions).find((v) => v.id === (hl2.json.version as { id: string }).id);
    report("Contacts: once listed, the number is no longer highlighted", hl2.status === 200 && hl2Version?.highlights.length === 0);
    for (const who of ["superintendent", "doctor"] as const) report(`Contacts: ${who} removes 403`, (await call(who, "DELETE", `/api/hospital/knowledge/contacts/${contactId}`)).status === 403);
    report("Contacts: the hospital administrator removes it", (await call("admin", "DELETE", `/api/hospital/knowledge/contacts/${contactId}`)).status === 200);

    // ── 4. Refused uploads, nothing kept ──
    const before = await prisma.knowledgeDocumentVersion.count();
    const docsBefore = await prisma.knowledgeDocument.count();
    const ids = await call("admin", "POST", "/api/hospital/knowledge", form(`case-${tag}.txt`, "text/plain", "Example: Smt Lata Devi 62 yrs, ABHA 91-2345-6789-0123, call +91 98765 43210.", { title: `Case example ${tag}` }));
    report("Identifiers: refused 400 CONTAINS_IDENTIFIERS with the kinds", ids.status === 400 && ids.json.code === "CONTAINS_IDENTIFIERS" && Array.isArray(ids.json.kinds) && (ids.json.kinds as string[]).includes("ABHA_NUMBER"));
    report("Identifiers: no value echoed back", !/Lata|2345|98765/.test(ids.text));
    const fname = await call("admin", "POST", "/api/hospital/knowledge", form(`UHID-AMCP-7Q2XKD notes ${tag}.txt`, "text/plain", "Clean text about oxygen."));
    report("Identifiers: a patient identifier in the file name is refused too", fname.status === 400 && fname.json.code === "CONTAINS_IDENTIFIERS");
    const docx = await call("admin", "POST", "/api/hospital/knowledge", form(`policy-${tag}.docx`, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])));
    report("DOCX: refused, asking for a PDF export", docx.status === 400 && docx.json.code === "DOCX_DEFERRED" && /PDF/.test(String(docx.json.error)));
    const fake = await call("admin", "POST", "/api/hospital/knowledge", form(`fake-${tag}.pdf`, "application/pdf", "just words, not a PDF"));
    report("Type: bytes that disagree with the type are refused", fake.status === 400 && fake.json.code === "TYPE_MISMATCH");
    const big = await call("admin", "POST", "/api/hospital/knowledge", form(`big-${tag}.txt`, "text/plain", Buffer.alloc(21 * 1024 * 1024, 0x61)));
    report("Size: a file over 20 MB is refused", big.status === 400 || big.status === 413, String(big.status));
    report("Refused uploads kept nothing", (await prisma.knowledgeDocumentVersion.count()) === before && (await prisma.knowledgeDocument.count()) === docsBefore);

    // ── 5. No hash, storage reference or file contents in any response ──
    const shas = (await prisma.knowledgeDocumentVersion.findMany({ where: { document: { title: { contains: tag } } }, select: { sha256: true, storageRef: true } }));
    const leaked = bodies.filter((b) => shas.some((s) => b.includes(s.sha256) || b.includes(s.storageRef)) || /"sha256"|"storageRef"|500 psi|400 psi/.test(b));
    report("Responses: no hash, no storage reference, no file contents", leaked.length === 0, `${bodies.length} responses`);
  } finally {
    server?.child.kill("SIGTERM");
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
