"use client";

/**
 * Week 4c — what a share covers, as the patient chooses it
 * (docs/CONSENT_SHARING_DESIGN.md §2, §6, §15): the categories, shown
 * pre-selected (every non-sensitive one but clinical notes) so the patient sees
 * the whole list and can untick anything; the sensitive categories (unticked,
 * each explained); an optional period. Used to issue a code and to approve a
 * request (where only the requested categories can be ticked).
 */
export const CATEGORY_LABEL: Record<string, string> = {
  PRESCRIPTIONS: "Prescriptions and medicines", LABS: "Lab results", IMAGING: "Scans and X-rays",
  DISCHARGE_SUMMARIES: "Discharge summaries", CONDITIONS: "Conditions and diagnoses", VITALS: "Vitals (blood pressure, pulse, temperature)",
  UPLOADS: "Documents you uploaded", CLINICAL_NOTES: "Doctors' clinical notes",
};
/** The pre-selected list (src/lib/sharing/categories.ts DEFAULT_SHARE_CATEGORIES). Clinical notes only if ticked. */
export const DEFAULT_SHARE_CHOICE = ["PRESCRIPTIONS", "LABS", "IMAGING", "DISCHARGE_SUMMARIES", "CONDITIONS", "VITALS", "UPLOADS"];
export const SENSITIVE_LABEL: Record<string, [string, string]> = {
  MENTAL_HEALTH: ["Mental health", "counselling, psychiatric care"],
  SEXUAL_HEALTH: ["Sexual health", "tests and treatment for sexually transmitted infections"],
  HIV: ["HIV", "HIV tests and treatment"],
  SUBSTANCE_USE: ["Substance use", "alcohol or drug treatment"],
  REPRODUCTIVE_HEALTH: ["Reproductive health", "pregnancy, contraception, fertility"],
};

export interface ShareChoiceValue { categories: string[]; sensitiveCategories: string[]; from: string; to: string }

export function ShareChoices({ value, onChange, allowed }: { value: ShareChoiceValue; onChange: (v: ShareChoiceValue) => void; allowed?: string[] }) {
  const toggle = (list: string[], x: string) => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);
  const cats = Object.keys(CATEGORY_LABEL).filter((c) => !allowed || allowed.includes(c));
  return (
    <div className="space-y-3 text-left">
      <fieldset>
        <legend className="text-[12px] font-medium text-text-secondary">What to share</legend>
        <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
          {cats.map((c) => (
            <label key={c} className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={value.categories.includes(c)} onChange={() => onChange({ ...value, categories: toggle(value.categories, c) })} />
              {CATEGORY_LABEL[c]}
            </label>
          ))}
        </div>
        <p className="mt-1 text-[11.5px] text-text-tertiary">Untick anything you don&apos;t want to share. Clinical notes are left out unless you tick them. Allergies are always included, so a doctor never prescribes something you react to.</p>
      </fieldset>
      <details className="rounded-lg border border-hairline px-3 py-2">
        <summary className="cursor-pointer text-[12.5px] font-medium">Sensitive records ({value.sensitiveCategories.length ? `${value.sensitiveCategories.length} included` : "hidden"})</summary>
        <p className="mt-1.5 text-[11.5px] text-text-tertiary">These stay hidden unless you tick them, for this share only.</p>
        <div className="mt-1.5 space-y-1">
          {Object.entries(SENSITIVE_LABEL).map(([k, [name, hint]]) => (
            <label key={k} className="flex items-start gap-2 text-[12.5px]">
              <input type="checkbox" className="mt-0.5" checked={value.sensitiveCategories.includes(k)} onChange={() => onChange({ ...value, sensitiveCategories: toggle(value.sensitiveCategories, k) })} />
              <span>{name} <span className="text-text-tertiary">— {hint}</span></span>
            </label>
          ))}
        </div>
      </details>
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <span className="text-text-secondary">Only records from</span>
        <input type="date" aria-label="From" value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} className="rounded-md border border-hairline bg-transparent px-2 py-1" />
        <span className="text-text-secondary">to</span>
        <input type="date" aria-label="To" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} className="rounded-md border border-hairline bg-transparent px-2 py-1" />
        <span className="text-[11.5px] text-text-tertiary">(optional)</span>
      </div>
    </div>
  );
}

export const choiceBody = (v: ShareChoiceValue) => ({
  categories: v.categories, sensitiveCategories: v.sensitiveCategories,
  ...(v.from || v.to ? { period: { ...(v.from ? { from: v.from } : {}), ...(v.to ? { to: v.to } : {}) } } : {}),
});
