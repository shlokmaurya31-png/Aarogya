# The patient app on low-end phones, slow networks and screen readers (Flagship 5, step 6)

- **Status:** 2026-11-10, branch `foundation/flagship-5`.
- **Why:** most of Aarogya's patients open it on an entry-level Android phone, often on a weak 4G signal, in their own language. Six screens carry most visits: home, the timeline (records), upload, booking (find a doctor), the family switcher, and insurance status.

## 1. What is checked, and where

| Check | Command | What |
|---|---|---|
| Phone budgets | `npm run perf:mobile` | Each screen cold, on a Moto G-class CPU and slow 4G: interactive within 3.5 s, and its JavaScript within the budget (§2) |
| Accessibility | `e2e/accessibility.spec.ts` (in `npm run e2e:smoke`) | axe, WCAG 2.2 AA, on the six screens in all 11 languages at 360 px wide; names, language, direction (§3) |
| Uploads on a dropping connection | `e2e/upload-resume.spec.ts`, `verify-postgres-resumable-upload` | The network cut mid-upload, resumed, and the stored file byte for byte the one sent (§4) |

## 2. Phone budgets (6a)

**Method** (`npm run perf:mobile`: `e2e-mobile/mobile-perf.spec.ts`, `playwright.mobile.config.ts`, through the same app, worker and synthetic fixture as the browser journeys):
- **Each screen cold:** a fresh browser context, so nothing is cached.
- **Throttled through the DevTools protocol** to Lighthouse's mobile profile:
  - the CPU 4× slower (a Moto G-class phone);
  - slow 4G: 562.5 ms round trip, 1.47 Mbit/s down, 675 kbit/s up;
  - a 360 px screen.
- **Median of three runs.**
- **Interactive** is the latest of three moments, all measured in the page: every script has run (the `load` event, so the screen is hydrated); the screen's heading is drawn and nothing says "Loading"; the last long task has ended.
- **JS** is the compressed size of every script the screen loaded.

**Budgets:** interactive within **3.5 s**; JS within **200 KB** (compressed).

| Screen | Before: interactive | Before: JS | After: interactive | After: JS |
|---|---|---|---|---|
| Home (`/patient`) | 5,555 ms | 326 KB | 3,364 ms | 177 KB |
| Timeline (`/patient/records`) | 5,566 ms | 328 KB | 3,359 ms | 178 KB |
| Upload (`/patient/documents`) | 5,528 ms | 328 KB | 3,327 ms | 179 KB |
| Booking (`/patient/doctors`) | 4,920 ms | 329 KB | 3,176 ms | 179 KB |
| Family switcher (`/patient/household`) | 5,580 ms | 333 KB | 3,380 ms | 183 KB |
| Insurance status (`/patient/insurance`) | 5,530 ms | 329 KB | 3,329 ms | 179 KB |

"Before" is commit `1ba4f02` (before this step), measured the same way. Every screen was over budget; every screen is now within it.

**What was fixed:**
1. **The whole translation dictionary shipped to every patient page:** `src/lib/i18n.ts`, 488 KB raw and 113 KB compressed, pulled in only because the theme toggle and the toasts asked for five strings. The shell's strings (theme, toasts, the patient app's navigation) now live in `src/lib/i18nShell.ts` with `useShellTranslation`. The full dictionary includes them, so `translate()` is unchanged elsewhere.
2. **framer-motion (44 KB compressed) on every page,** for the AI assistant's launcher and the toasts' entrance. These are now a CSS entrance (`.aarogya-pop`), which is off under `prefers-reduced-motion`.
3. **About 270 KB of fonts preloaded ahead of the scripts:** both variable Finlandica files, the italic included, and the mono. They are no longer preloaded (`display: swap` shows text at once), and the italic and mono files load only when used.

**Watch:** the margin is about 0.12–0.32 s. The next cost on the critical path is each screen's own data call, made after hydration (one more round trip). If a screen slips, preload that call from the server, or render its first data on the server.

## 3. Accessibility (6b)

**Standard:** WCAG 2.2 AA, checked by axe (`@axe-core/playwright` 4.14.0, rule tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`; touch targets included).

**The check** (`e2e/accessibility.spec.ts`, part of `npm run e2e:smoke` and CI): the six screens, at 360 px with touch, in each of the 11 app languages (66 screens):
- **axe:** no violation;
- **language:** `<html lang>` is the app language, and `dir` is `rtl` for Urdu and `ltr` otherwise;
- **names in that language:** the navigation landmark and its links, sign-out and the language picker;
- **no sideways scroll.**

**Found (axe, before) and fixed:**

| Issue | Where | Fix |
|---|---|---|
| Colour contrast (serious): secondary and tertiary text at 3.9:1 and 2.3:1, and the status colours at 4.2–4.3:1 on warm-white; 16–24 elements per screen, including Sign out and the mobile navigation | Every screen | The tokens raised to at least 4.5:1 on every light surface and its tints: text secondary 0.60 → 0.72, tertiary 0.40 → 0.66; emerald `#11692f`, amber `#9a4308`, red `#b91c1c`. Dark-theme secondary and tertiary raised to 0.78 and 0.70. App-wide, since every surface uses the same tokens |
| A select with no name (critical) | Family (`/patient/family`) | Named "Relationship"; its two inputs named too |
| No language or direction for the shell; English-only navigation names | Every screen | The shell sets `lang`/`dir` from the app language, adds a language picker, and names the navigation, its links, sign-out and a "skip to main content" link in all 11 languages |
| Toasts not announced | Every screen | A polite live region |

**Departures:**
- **The screens' own text is still English.** Until it is translated, `<main>` is marked `lang="en" dir="ltr"`, so a screen reader pronounces it correctly and English sentences don't reflow right to left. The shell (header, navigation, sign-out, the language picker) is in the chosen language and mirrors for Urdu.
- **The AI assistant's buttons** ("Open Aarogya AI", "Close assistant") are still English.
- **The new strings are machine translations** (24 keys × 10 languages, `src/lib/i18nShell.ts`), awaiting the native-speaker review of pre-launch item 23.

## 4. Uploads that survive a dropping connection (6c)

- **The phone sends the file in pieces of 256 KB, in order** (`src/lib/patient/experience/resumableUpload.ts`, routes `/api/patient/uploads`):
  1. `POST` starts it: the name, type and size, checked against the bucket's rules before any byte is stored;
  2. `PUT ?offset=` sends each piece;
  3. `GET` says how much has arrived;
  4. `POST …/complete` hands the whole file to the same `uploadPatientDocument` as a one-shot upload, with the same checks, the same owner and the same `PersonDocumentUploaded` event, and then deletes the pieces.
- **A piece sent twice is taken once** (its answer was lost on the way back). A piece out of order is refused with how much has arrived, so the phone carries on from there. Completing twice is once.
- **The pieces are kept only until the upload completes** (`UploadSession`, `UploadChunk`; migration `20261110120000_upload_sessions`). An unfinished upload is deleted after a day by the runner (`purgeExpiredUploads`). The session names the account, not a Person or a facility: the document's owner is decided at completion, as for any upload.
- **On the screen** (`src/components/patient-portal/ResumableUpload.tsx`):
  - "Choose a file" or "Take a photo", which opens the camera directly (`capture="environment"`);
  - a progress bar that screen readers announce;
  - on a drop, "Connection lost at 40%. It will carry on from there when you're back online." It carries on when the browser is online again, or on its own with backoff (1 s, doubling, at most 30 s), from what the server has.
- **Proof:**
  - **Journey** (`e2e/upload-resume.spec.ts`): a 1.2 MB report, with the network cut while the third piece is on its way. The screen says the connection was lost and how far it got; with the network back it finishes, and the stored file's SHA-256 is the chosen file's.
  - **Gate** (`verify-postgres-resumable-upload`, 15 checks): type and size; in order; a duplicate taken once; out of order refused; completing early refused; another account's 404; the exact file with its event; pieces deleted; completing twice is once; expiry and the purge.
