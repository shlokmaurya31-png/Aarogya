# Aarogya product spec

- **Status:** Product direction, set 2026-10-17. Designs follow from it, phase by phase (see *Build order*); no feature here is built until its design is approved.
- **Designs so far:** `docs/RAG_DESIGN.md` (4b), `docs/DOCUMENT_PIPELINE_DESIGN.md` (4a).

## Vision

Every Indian gets a free, lifelong health record that they own. It reads their old paper reports in their own language, and any doctor they choose can see it in seconds.

## Principles

1. **Free for patients and doctors, for good.**
2. **The patient owns the record.** They see who accessed it, and they can revoke access.
3. **Shared by consent, never public.** Someone sees a record only through:
   - a share from the patient;
   - the treating hospital;
   - an audited emergency break-glass.
4. **Verified vs patient-provided, always visible.**
   - *Verified* means hospital-issued, signed and checkable by QR.
   - *Patient-provided* means uploaded by the patient or a proxy.
   - The label shows wherever the information appears.
5. **Originals are never replaced.** Translations and AI output sit beside the original.
6. **India-first:**
   - 11 languages;
   - low-end Android phones;
   - weak networks;
   - ready for ABHA.
7. **One person, one record.** A family can share an account, but every member is their own patient with their own consent.
8. **AI assists, never decides.** AI output is labelled and cites its sources.

## Features

### A. Document pipeline

1. **Upload.** A photo or PDF, in any language.
2. **Keep the original** exactly as uploaded.
3. **OCR and language detection.**
4. **Translate** into the app language. Medicine names, doses, units, numbers and lab values are copied exactly and never translated.
5. **Extract facts**, each with a confidence:
   - document type and date;
   - doctor or hospital;
   - diagnoses;
   - medicines, with dose and frequency;
   - lab values, with units and reference ranges;
   - procedures;
   - allergies.
6. **The patient confirms.** Low-confidence fields are flagged. The patient can confirm, correct or reject each fact.
7. **Merge into the record** as patient-provided, linked to the original page.
8. **Events update** the timeline and the AI index.

Where a verified record and an upload disagree, the verified record wins, and the disagreement is shown. Every step can resume after a failure and emits an event.

### B. Consent sharing

- **Share code or QR:**
  - for one visit;
  - lasts 24 hours by default;
  - ends early when the patient asks.
- **Access requests** that the patient approves. The patient chooses:
  - which categories: prescriptions, labs, imaging, discharge summaries, uploads;
  - optionally, a date range.
- **Treating-hospital access.**
- **Break-glass.**
- **Sensitive categories hidden by default.** Mental health, sexual health, HIV and similar categories need an explicit opt-in.
- **Access log and one-tap "revoke all"**, both visible to the patient.
- **Mirrors ABDM consent:** purpose, scope, recipient and period.

### C. Doctor network

- **An independent doctor identity.** The doctor is a person first. That person is linked to staff profiles and to practice locations: a hospital, their own clinic, teleconsultation.
- **Profile fields:**
  - registration number and state council (gives the verified badge);
  - qualifications;
  - specialties, from a fixed list;
  - languages;
  - practice locations, each with fee and timings;
  - modes: in person, video, home visit;
  - years of experience.
- **Verification first.** A doctor is not public or bookable until verified: a manual document check now, HPR later.
- **Search by:**
  - specialty, with a symptom-to-specialty mapping;
  - language;
  - distance;
  - fee;
  - mode;
  - next available slot.
- **Booking** uses the existing appointment and bookability engine and can attach a record share.

### D. Household accounts

- **Size:** managers plus up to 8 member profiles (configurable), with a profile switcher.
- **Member types:**
  - **Self.**
  - **Managed minor.** A parent controls the profile. At 18 it becomes the member's own, and they choose whether their parents keep access.
  - **Dependent adult.** Consent for a proxy is recorded, and the adult can take control back.
  - **Linked adult.** Has their own login and chooses what the manager sees.
- **Proxy permissions** are granted separately: view, upload, book, share, insurance, use the AI.
- **Ownership never transfers.**
- **Adults always see their proxies** and can remove them.
- **Sensitive categories** are hidden from proxies unless the member allows them.
- **Builds on** the existing family delegation and consent services.

### E. AI assistant (RAG)

- **Visit brief** for a doctor who has a share:
  - history relevant to the reason for the visit;
  - every line cited;
  - each line labelled verified, patient-provided or translated.
- **Chart Q&A** for doctors, and for nurses on patients assigned to them.
- **Explain my report** for patients and proxies, in their language, with no diagnosis.
- **Health timeline.**
- **Pre-visit questions.**
- **"No record found"** rather than guessing.
- **Real data only** after a data-processing agreement and patient consent. This is a switch, off by default.

### F. Insurance and no queues

- **Insurance cards** for each household member.
- **Pre-arrival check-in**, with a record share, insurance and a queue token.
- **For the patient:**
  - pre-authorization status;
  - cashless status at discharge;
  - paying their share in the app;
  - claim tracking.
- **Built on** the existing coverage, pre-auth, NHCX, claims, queue and payment services.

## Business model

- **Free:** patients and doctors.
- **Revenue:**
  - Hospital OS, per facility;
  - insurers and TPAs, per claim;
  - government digital-health incentives;
  - later, labs and pharmacies;
  - Scholar.
- **Never:** selling data, selling search rankings, or ads in the record.

## Guardrails

- **DPDP:** notice and consent for each purpose.
- **Children:** a guardian consents for a child's data, and children are never profiled.
- **Data stays in India** by default.
- **Telemedicine** follows India's Telemedicine Practice Guidelines.
- **A clinical advisor signs off:**
  - AI modes;
  - sensitive categories;
  - evaluation answers.
- **Break-glass** must give a reason, is time-limited, is shown to the patient, and is reviewed.
- **Records retention and legal holds** are respected.

## Build order

Each phase ends with its own gates and end-to-end tests.

| Phase | Scope |
|---|---|
| 4a | Document pipeline (A) |
| 4b | RAG and the AI modes (E) |
| 4c | Consent sharing upgrade (B) |
| 5a | Doctor network (C) |
| 5b | Households (D) |
| 5c | Patient insurance and check-in (F) |
