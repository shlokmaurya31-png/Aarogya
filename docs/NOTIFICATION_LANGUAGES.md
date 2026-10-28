# Notification texts in every app language

- **Status:** 2026-10-28, Flagship 1b (pre-launch item 23). Machine translations in; native-speaker review pending for every language but English.
- **Code:** `src/lib/notifications/texts.ts` (the templates), `src/lib/notifications/review.json` (the review list), `src/lib/notifications/texts.test.ts` (the check).

## What is covered

| Text | Where it is sent from | Language used |
|---|---|---|
| The eight person notifications, title and body (access summary, emergency access, access request, coming of age, check-in open, insurance update, documents requested, bill ready) | `src/lib/person/notifications.ts` | The person's `preferredLanguage` |
| Phone-link code | `src/lib/person/linking.ts` | The person linking |
| Account-merge code and email subject | `src/lib/person/merge.ts` | Each of the two accounts' own |
| Add-a-child code | `src/lib/household/households.ts` | The parent's |
| Guardian-choice code | `src/lib/household/guardianConsent.ts` | The guardian's |
| Dependent-adult consent code and email subject | `src/lib/household/dependentConsent.ts` | The member's (the message is for them) |
| Claim-my-profile code and email subject | `src/lib/household/comingOfAge.ts` | The member's |
| Work-login phone code | `src/lib/auth/loginPhones.ts` | English: a staff login has no language yet |

Languages: `en`, `hi`, `mr`, `ta`, `bn`, `gu`, `te`, `kn`, `ml`, `or`, `ur` (`SUPPORTED_LANGUAGES`). A language the app doesn't have falls back to English, and the notification's `language` field says so.

## Rules the check enforces

1. Every template exists in every language, non-empty.
2. The same value placeholders as English (`{code}`, `{minutes}`, `{opens}`, `{people}`, `{days}`). A plural choice (`{opens|time|times}`) may be used or not, but only for a value English has.
3. Numbers are never translated: the digits in English appear unchanged, and no script's own digits are used; filled values are inserted exactly as the code passes them.
4. "Aarogya" and the app's English-only button labels in quotes (`"Claim my profile"`) stay as they are, so the person can find them.
5. Each text is in its language's own script.
6. English output is byte-for-byte what it was before (the gates read the codes out of it).
7. Every non-English text is in `review.json` with the English it was made from and its status. Changing either the English or the text makes the check fail until `npm run docs:notification-review` is run, which resets that entry to "pending native-speaker review".

Medicine names and dates never appear in these texts: they carry no clinical detail (the app shows it). Urdu is right-to-left: `listOwnNotifications` returns `dir: "rtl"` with each Urdu notification, and a screen showing one sets `dir` on it. SMS and email text are sent without bidi control characters (some phones show them as boxes).

## Reviewing

For each language, a reviewer fluent in it (and familiar with health-care wording) reads the entries in `review.json`, fixes the text in `texts.ts` where needed, runs `npm run docs:notification-review`, then sets each entry they approve to `"status": "REVIEWED"` with their name in `reviewer`. The Hindi notification texts predate this work (Weeks 4c and 5c) but were never reviewed either, so they are pending too.

## Not covered yet

- The account emails sent in English only: record linked or unlinked (`src/lib/person/linking.ts`), the phone-changed SMS to the old number, account closure (`src/lib/person/closure.ts`) and the household invitation (whose recipient may have no Aarogya language yet).
- The staff work-login code is sent in English until staff logins carry a language.
