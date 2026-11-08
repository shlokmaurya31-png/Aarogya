import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LANGUAGE_SCRIPT, SUPPORTED_LANGUAGES } from "@/lib/documents/vocab";
import { notificationText } from "@/lib/person/notifications";
import { PENDING_REVIEW, type ReviewEntry } from "./review";
import { TEMPLATE_KEYS, TEMPLATES, fillTemplate, messageText, placeholders, pluralVariables, textDirection } from "./texts";

const KINDS = ["ACCESS_SUMMARY", "BREAK_GLASS_ACCESS", "ACCESS_REQUESTED", "COMING_OF_AGE", "CHECKIN_OPEN", "INSURANCE_UPDATE", "DOCUMENTS_REQUESTED", "BILL_READY"];
const SCHEMA = readFileSync(path.join(__dirname, "..", "..", "..", "prisma", "schema.prisma"), "utf8");
const REVIEW: ReviewEntry[] = JSON.parse(readFileSync(path.join(__dirname, "review.json"), "utf8"));

// The letters of each script (ISO 15924), to catch a text pasted under the wrong language.
const SCRIPT_RANGE: Record<string, RegExp> = {
  Latn: /[A-Za-z]/, Deva: /[ऀ-ॿ]/, Taml: /[஀-௿]/, Beng: /[ঀ-৿]/, Gujr: /[઀-૿]/,
  Telu: /[ఀ-౿]/, Knda: /[ಀ-೿]/, Mlym: /[ഀ-ൿ]/, Orya: /[଀-୿]/, Arab: /[؀-ۿ]/,
};
// A script's own digits: numbers are always ASCII digits.
const NATIVE_DIGITS = /[०-९০-৯૦-૯୦-୯௦-௯౦-౯೦-೯൦-൯٠-٩۰-۹]/;
const without = (t: string) => t.replace(/\{[^}]*\}/g, "");
const digitRuns = (t: string) => (without(t).match(/\d+/g) ?? []).sort();
const quoted = (t: string) => (t.match(/"[^"]+"/g) ?? []).sort();
const count = (t: string, w: string) => t.split(w).length - 1;

describe("notification texts in every app language (pre-launch item 23)", () => {
  it("covers every notification kind in the schema, title and body", () => {
    const kinds = /enum PersonNotificationKind \{([^}]*)\}/.exec(SCHEMA)![1].split("\n").map((l) => l.trim()).filter((l) => /^[A-Z_]+$/.test(l));
    expect(kinds.sort()).toEqual([...KINDS].sort());
    for (const k of KINDS) for (const part of ["title", "body"]) expect(TEMPLATE_KEYS).toContain(`notify.${k}.${part}`);
  });

  it.each(TEMPLATE_KEYS)("%s exists in all eleven languages with English's placeholders", (key) => {
    const en = TEMPLATES[key].en;
    for (const lang of SUPPORTED_LANGUAGES) {
      const t = TEMPLATES[key][lang];
      expect(t?.trim(), `${key} ${lang}`).toBeTruthy();
      expect(placeholders(t), `${key} ${lang}: the values it inserts`).toEqual(placeholders(en));
      for (const v of pluralVariables(t)) expect(placeholders(en), `${key} ${lang}: a plural of an unknown value`).toContain(v);
    }
  });

  it.each(TEMPLATE_KEYS)("%s: numbers, the brand and the app's button labels are never translated", (key) => {
    const en = TEMPLATES[key].en;
    for (const lang of SUPPORTED_LANGUAGES) {
      const t = TEMPLATES[key][lang];
      expect(NATIVE_DIGITS.test(t), `${key} ${lang}: a script's own digits`).toBe(false);
      expect(digitRuns(t), `${key} ${lang}: the numbers`).toEqual(digitRuns(en));
      expect(count(t, "Aarogya"), `${key} ${lang}: "Aarogya"`).toBe(count(en, "Aarogya"));
      expect(quoted(t), `${key} ${lang}: quoted labels`).toEqual(quoted(en));
    }
  });

  it.each(TEMPLATE_KEYS)("%s is written in each language's own script", (key) => {
    for (const lang of SUPPORTED_LANGUAGES) {
      if (lang === "en") continue;
      const letters = without(TEMPLATES[key][lang]).replace(/Aarogya|"[^"]+"/g, "");
      expect(SCRIPT_RANGE[LANGUAGE_SCRIPT[lang]].test(letters), `${key} ${lang}`).toBe(true);
    }
  });

  it("fills values exactly, in every language, and refuses a hole", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const t = messageText("code.LINK", lang, { code: "042917", minutes: 10 });
      expect(t.language).toBe(lang);
      expect(t.text).toContain("042917");
      expect(t.text).toContain("10");
      expect(t.text).not.toMatch(/[{}]/);
    }
    expect(() => fillTemplate(TEMPLATES["code.LINK"].ta, { code: "1" })).toThrow(/minutes/);
  });

  it("keeps English exactly as before, plurals included", () => {
    expect(notificationText("ACCESS_SUMMARY", "en", { opens: 1, people: 1 }).body).toBe("Your record was opened 1 time by 1 person yesterday. Open Aarogya to see who, and to stop any access you didn't expect.");
    expect(notificationText("ACCESS_SUMMARY", "en", { opens: 3, people: 2 }).body).toMatch(/^Your record was opened 3 times by 2 people yesterday\./);
    expect(notificationText("COMING_OF_AGE", "en", { days: 30 }).body).toMatch(/in 30 days\./);
    expect(messageText("code.CLAIM", "en", { code: "123456", minutes: 30 }).text).toBe('Aarogya: your health record is ready for you to take over. Your code is 123456 (expires in 30 minutes). Use it in the app with "Claim my profile".');
    // Flagship 2e: the account messages, as they were sent in English before.
    expect(messageText("account.LINKED.body", "en").text).toBe("A hospital record was connected to your Aarogya account. Open the app to see which one and when. If this wasn't you, contact the hospital.");
    expect(messageText("account.UNLINKED.subject", "en").text).toBe("A hospital record was disconnected from your Aarogya account");
    expect(messageText("account.PHONE_CHANGED", "en").text).toBe("The phone number on your hospital record with Aarogya was changed. If you didn't ask for this, contact the hospital.");
    expect(messageText("account.INVITED.body", "en").text).toBe("Someone invited you to their family on Aarogya. Open the app to accept or decline. Nobody sees your record unless you choose what they may see.");
    expect(messageText("account.CLOSED.body", "en", { days: 30 }).text).toMatch(/will be deleted in 30 days\. Until then/);
  });

  it("writes in the person's language, English for one the app doesn't have", () => {
    const ta = notificationText("ACCESS_SUMMARY", "ta", { opens: 3, people: 2 });
    expect(ta.language).toBe("ta");
    expect(ta.body).toContain("3");
    expect(ta.body).toContain("நபர்களால்");
    expect(notificationText("ACCESS_SUMMARY", "ta", { opens: 1, people: 1 }).body).toContain("நபரால்");
    expect(notificationText("BILL_READY", "fr").language).toBe("en");
    expect(messageText("code.MERGE", null, { code: "1", minutes: 15 }).language).toBe("en");
  });

  it("Urdu is right-to-left, every other language left-to-right", () => {
    for (const lang of SUPPORTED_LANGUAGES) expect(textDirection(lang)).toBe(lang === "ur" ? "rtl" : "ltr");
  });

  it("every non-English text is in the review list with the English and text it was made from, pending until a reviewer says otherwise", () => {
    const expected = TEMPLATE_KEYS.flatMap((key) => SUPPORTED_LANGUAGES.filter((l) => l !== "en").map((language) => ({ key, language, en: TEMPLATES[key].en, text: TEMPLATES[key][language] })));
    expect(REVIEW.map(({ key, language, en, text }) => ({ key, language, en, text }))).toEqual(expected);
    for (const e of REVIEW) {
      expect([PENDING_REVIEW, "REVIEWED"]).toContain(e.status);
      if (e.status === "REVIEWED") expect(e.reviewer, `${e.key} ${e.language}: a review names its reviewer`).toBeTruthy();
    }
  });
});
