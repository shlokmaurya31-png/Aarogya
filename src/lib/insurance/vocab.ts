/**
 * Week 5c — patient insurance and check-in: fixed values
 * (docs/PATIENT_INSURANCE_DESIGN.md §14, the 5c decisions).
 */
/** Government schemes a card can be for (verified at the desk for now; PM-JAY is a payer type, not an integration). */
export const GOVERNMENT_SCHEMES = ["PM_JAY", "CGHS", "ESIC", "STATE_SCHEME"] as const;
export const SCHEME_LABEL: Record<(typeof GOVERNMENT_SCHEMES)[number], string> = {
  PM_JAY: "Ayushman Bharat PM-JAY", CGHS: "CGHS", ESIC: "ESIC", STATE_SCHEME: "State health scheme",
};
export const PAYER_TYPE_LABEL = { PRIVATE_INSURER: "Health insurance", CORPORATE: "Employer (corporate) cover", GOVERNMENT_SCHEME: "Government scheme" } as const;

/** Pre-arrival check-in opens this many hours before the visit or planned admission… */
export const CHECKIN_OPENS_HOURS = 24;
/** …and closes this many hours before it (5c decision: 1 hour; the design's 30 minutes after is replaced). */
export const CHECKIN_CLOSES_HOURS = 1;
/** A card shared at check-in stays readable by the facility until this long after the visit. */
export const CARD_SHARE_DAYS_AFTER = 2;
/** A check-in share (CHECKIN) lasts until a day after the visit. */
export const CHECKIN_SHARE_DAYS_AFTER = 1;

/** Why a check-in needs the desk (closed codes, shown to the patient in plain words). */
export const NEEDS_DESK_REASONS = ["CARD_NOT_VERIFIED", "DETAILS_MISMATCH", "PAYMENT_BEFORE_CONSULTATION", "DOCUMENTS_NEEDED"] as const;
export const NEEDS_DESK_TEXT: Record<(typeof NEEDS_DESK_REASONS)[number], string> = {
  CARD_NOT_VERIFIED: "Please stop at the desk: your insurance card couldn't be checked yet.",
  DETAILS_MISMATCH: "Please stop at the desk: some of your details need checking.",
  PAYMENT_BEFORE_CONSULTATION: "Please stop at the desk: a payment is due before your consultation.",
  DOCUMENTS_NEEDED: "Please stop at the desk: a document is needed.",
};

export const ELIGIBILITY_TEXT = {
  SELF_PAY: "You'll pay yourself",
  PENDING: "Eligibility pending: the hospital will check your card",
  VERIFIED: "Insurance checked by the hospital",
  NOT_VERIFIED: "Insurance couldn't be checked: please stop at the desk",
} as const;
