# The browser's storage after logout: audit (Flagship 5, step 3c)

- **Status:** 2026-11-10. Audited and fixed on branch `foundation/flagship-5`.
- **Rule:** no patient data may remain in the browser after logout or session expiry: not in Cache Storage (Flagship 4, `public/sw.js`), and not in localStorage, sessionStorage or IndexedDB (this audit).
- **Scope:** the main app (the Hospital OS, the patient app, the doctor network and Scholar). The ward tablet's app has its own rules (`docs/OFFLINE_NURSING_DESIGN.md` §8, §13.4, §13.8).

## What the app keeps in the browser

| Where | Key | Written by | Holds | Patient data? |
|---|---|---|---|---|
| localStorage | `aarogya-theme` | `useThemeStore` (zustand `persist`), `ThemeInit`, the inline script in `src/app/layout.tsx` | `light` / `dark` / `system` | No |
| localStorage | `aarogya-language` | `useLanguageStore` (zustand `persist`) | One of the eleven app languages | No |
| sessionStorage | — | Nothing in the app's code | — | — |
| IndexedDB | `aarogya-ward` | The ward tablet's store (`src/lib/ward/store.ts`) | The pack and the outbox, each record sealed with AES-GCM under the tablet's non-exportable key | Only sealed, and only on a ward tablet |
| Cache Storage | `aarogya-shell-*` | `public/sw.js` | Public pages and static files only (Flagship 4) | No |
| Cache Storage | `aarogya-ward-*` | `public/ward-sw.js` | The `/ward` page and its static files, with no names since Flagship 5b | No |

Found by reading every use of `localStorage`, `sessionStorage`, `indexedDB`, `caches` and zustand's `persist` in `src/`, and by dumping all four stores in the browser after browsing a chart and a shared record (as a doctor) and home, records, family and insurance (as a patient). The app's own code stores no patient data in any of them.

## The gap, and the fix

**The gap:** logout cleared Cache Storage only. Anything a library or a future screen put in sessionStorage, localStorage or IndexedDB (a draft, a cached query, a form's saved state) would have outlived the session on a shared phone or a hospital PC. Nothing does today, but nothing stopped it either.

**The fix** (`clearAppData`, `src/lib/pwa/clearCaches.ts`; was `clearAppCaches`), run on every logout (the Hospital OS, patient and Scholar shells) and on reaching any sign-in page (where an expired session lands, `PwaRegister`):
- **sessionStorage:** emptied.
- **localStorage:** everything removed except the device's theme and language (`KEPT_LOCAL_KEYS`), which describe the device, not a person.
- **IndexedDB:** every database deleted except the ward tablet's sealed store (`aarogya-ward`), whose outbox may hold records not yet synced; only the ward app deletes it ("Hand back the tablet").
- **Cache Storage:** as before (Flagship 4).

New storage in the app should not rely on this sweep: keep patient data out of the browser, and if something must be kept offline, seal it as the ward store does and give it its own wipe.

## Proof

- **Journey** (`e2e/cache-privacy.spec.ts`):
  - **The doctor:** while signed in, no store holds the patient's name, id, share code, email or phone. A leftover carrying the patient's name is then planted in localStorage, sessionStorage and a new IndexedDB database, as a positive control. After sign-out, none of the secrets is anywhere, sessionStorage is empty, localStorage holds only the theme and language, and no database but the ward store exists.
  - **The patient** (home, records, family, insurance): the same checks, plus Cache Storage.
  - **The ward tablet** (Flagship 5b): no names after hand-back.
- **Unit test:** `src/lib/pwa/clearCaches.test.ts`, which keys are kept.

## Decisions taken

1. **Theme and language survive logout.** They are the device's settings, and a shared phone's next user would otherwise get the default language.
2. **The ward store survives a main-app logout.** Deleting it could lose doses recorded offline and not yet synced. It is sealed, and the ward app's own sign-out deletes it.
3. **`Clear-Site-Data` stays `"cache"`**, not `"storage"` (Flagship 4): `"storage"` would wipe the ward store too. The client-side sweep does the rest.
