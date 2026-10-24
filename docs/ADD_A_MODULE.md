# Adding a module the right way

- **Status:** 2026-10-24, at the end of Week 5 (foundation v1).
- **Read first:** `docs/ARCHITECTURE.md` and `AGENTS.md` (this Next.js version differs from older ones).
- **Why follow it:** a module is done when the CI rules, the gates and the core journey all know about it. Skipping a step usually fails a test named below; that is on purpose.

## The steps, in order

1. **Write the design.** Add `docs/<MODULE>_DESIGN.md` with goals, the data model, access, events, gates, decisions and open questions. Once built, add an **"As built"** section with what changed and why. Anything blocking real use goes in `docs/PRE_LAUNCH_CHECKLIST.md`.

2. **Decide who owns each row.**
   - **The facility** (its records, its workflow): carry `facilityId` (and `organizationId` where the module needs it). Every read and write resolves the facility from the session; another facility's id is a 404.
   - **The Person** (their own data, their choices): carry `personId` and no facility column, and add the model to `PERSON_SCOPED_MODELS` in `src/lib/person/tenancy.ts`.
   - **A facility row that names a Person:** add it to `FACILITY_MODELS_WITH_PERSON`.
   - **Merges:** in both Person cases, re-point the model in `src/lib/person/merge.ts`; `merge.test.ts` checks it.
   - **Tests:** `tenancy.test.ts` fails on a `personId` model that isn't classified.

3. **Models and the migration.**
   - Edit `prisma/schema.prisma`. Use enums for closed sets: the schema-constraints gate fails on free-text status columns.
   - Write an **additive** migration (new tables and columns; nullable or defaulted; new enum values). Generate it with `prisma migrate diff`, read it, and never drop or rewrite data in place. If existing rows would need a guess, the migration refuses instead.
   - Run it on `aarogya_verify` with **both** `DATABASE_URL` and `DIRECT_URL` pointing there, and confirm `migrate diff` reports no difference. CI's "Migration drift" job checks the same.

4. **Events: every state change emits in its transaction.**
   - Add a contract per event to `src/lib/events/catalogue.ts`. It needs:
     - a scope;
     - a sensitivity;
     - a producer description;
     - a strict payload of ids, closed codes and counts. No names, values, free text, numbers a person could be identified by, or any key the sensitive guard forbids. Rename the key; never weaken the guard.
   - Add a new aggregate type to `AGGREGATE_TYPES` (`src/lib/events/types.ts`).
   - **Changing a shipped event?** Add a new version; never edit the old contract. Update gates that assert the version.
   - Emit with `emitDomainEvent(tx, …)` (person-scoped) or `emitFacilityEvent(tx, …)` (facility-scoped), inside the same `prisma.$transaction` as the write.
   - A write that is not a state change worth announcing gets a categorized entry in `src/lib/events/emitExemptions.ts`, for example:
     - a pending step whose outcome is emitted later (`PROCESS_STEP`, with its `boundary` events);
     - an access-log line written as part of a read (`BOOKKEEPING`);
     - a login's credential (`ACCOUNT_SECURITY`).

     `emitCoverage.test.ts` fails on anything else.
   - Run `npm run docs:events` to regenerate `docs/EVENT_CATALOGUE.md`; `catalogueDoc.test.ts` fails if it drifts.

5. **Consumers, for reactions to other modules' events.**
   - Write a `DomainEventConsumer` with a stable `name`, the `handles` list, and an **idempotent** `handle`, since delivery is at least once. A consumer's own writes emit their own events.
   - Register it in `src/lib/runner/consumers.ts` and add its name to `EXPECTED_CONSUMERS`.
   - Time-based work (expiry, reminders, lapses) goes in a sweep called from `runTick` (`src/lib/runner/tick.ts`), with a batch size.
   - The core journey must exercise the consumer, or the "every registered consumer processed journey events" check fails.

6. **Access: through the resolvers, never around them.**
   - Person-level data is read with `personAccess(actor, personId, purpose)`; extend it if the module needs a new way in or purpose. Report `null` as a 404, never a 403 that confirms existence.
   - Facility data uses `requireFacilityStaff(permission)` or the authorization engine (`requireAuthorization`, with a policy in `src/lib/auth/authorize/policies.ts` for security-sensitive actions).
   - Permissions live in `src/lib/auth/permissions.ts`.
   - Log every staff or proxy read of person-level data in the person's access log.
   - If doctors can reach it, apply the same-human rule (`src/lib/doctors/self.ts`).
   - Anything that may reach an AI or document provider goes through the real-data gate (`src/lib/ai/realData.ts`).

7. **Routes and screens.**
   - Routes under `src/app/api/` stay thin: authenticate, resolve the tenant or person, call one service, return. Wrap each in `withApiErrors`.
   - The tenancy sweep probes every hospital route as every tenant. Map a new `[id]` segment to its model in `SEGMENT_MODELS` (`scripts/verify-postgres-tenancy-sweep.ts`), and make an unknown or foreign id a 404, never an empty 200.
   - Screens use real `role`, `aria-label` and labels, so the browser tests can find them by role.
   - Plain words for patients: no codes, no amounts in notifications.

8. **Gates.**
   - Write `scripts/verify-postgres-<module>.ts`:
     - import `./lib/gateBootstrap` first (the database guard);
     - prove each guarantee;
     - include positive controls, so a refusal means something;
     - zero-tolerance leak checks with canaries where data could cross a boundary.
   - Add it to `scripts/verify-all.ts`, before the facility-consistency and late whole-database gates.
   - Extend the core journey (`scripts/verify-postgres-core-journey.ts`) with the module's story.
   - Run the area's gates after each commit, and the full `npm run verify:all` (with your task's reset consent) every few commits and before the PR.

9. **A browser journey.**
   - Add `e2e/<module>.spec.ts`, using only synthetic fixtures from `scripts/lib/e2eFixture.ts`.
   - Hospital-side steps without a screen run through `scripts/lib/e2eHospitalSteps.ts` (called with `hospitalStep` from `e2e/steps.ts`), guarded by `scripts/lib/e2eGuard.ts`.
   - `npm run e2e:smoke` runs them all, locally and in CI.

10. **Before the PR,** all of these pass:
    - `npm test`;
    - `npm run lint`;
    - `npm run build`;
    - `npm run verify:all`;
    - `npm run e2e:smoke`.

    Update the design's "As built", the pre-launch checklist, `docs/DATA_DICTIONARY.md` (new models) and the event catalogue (generated). Never push to `main`; open a PR from a work branch.

## Checklist

- [ ] Design doc, with "As built" and pre-launch items
- [ ] Rows classified (facility or Person); merge re-points person rows
- [ ] Additive migration; no drift
- [ ] Every state change emits a catalogued event in its transaction; exemptions categorized; catalogue regenerated
- [ ] Consumers registered, idempotent, exercised by the core journey
- [ ] Person reads through `personAccess`; facility reads tenant-checked; 404 for foreign ids; access logged
- [ ] Gates with positive controls and canaries; added to `verify:all`; core journey extended
- [ ] A browser journey
- [ ] tests, lint, build, verify:all and e2e green
