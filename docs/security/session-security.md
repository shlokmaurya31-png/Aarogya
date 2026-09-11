# Session Security

## Current architecture

Aarogya sessions are **stateless, HMAC-SHA256-signed cookies**. There is no
server-side session store.

| Property | State |
| --- | --- |
| `httpOnly` | yes |
| `secure` | yes in production |
| `sameSite` | `lax` |
| Expiry | 14 days, enforced on decode |
| Signature | HMAC-SHA256, compared with `timingSafeEqual` |
| Role | **re-derived from the database** on every request, never trusted from the cookie |
| Facility | **never in the cookie**; derived from the staff profile |

That design was reviewed and kept. It is sound, and replacing it would have been
churn for its own sake.

## What C4 added

### Revocation

The one genuine weakness of a stateless cookie: once issued it is valid until it
expires, and there is no way to take it back.

`User.tokenVersion` fixes that with the smallest possible change. Every cookie
carries the version it was minted at; `requireSession` refuses a mismatch.
Bumping the counter invalidates **every** cookie that user holds, instantly.

Covered: logout, logout-everywhere, password change, role change, staff
deactivation, administrative revoke, suspected compromise.

```ts
await revokeAllSessions({ userId, byUserId, reason });   // bump
await invalidateSessionsOnCredentialChange(userId);      // on password change
```

A pre-C4 cookie has no `ver` and reads as `0`, matching the column default, so
existing sessions keep working until something bumps them.

**Known limitation: per-device revocation is NOT implemented.** Revoking one
device while leaving others signed in needs per-session state, which means an
unbounded table. The value did not justify it. This is a stated limitation, not
an implied capability.

### Authentication recency

Cookies now carry `iat`. `sessionAuthAgeMs()` reports how long ago the session
authenticated, and the authorization engine uses it for step-up.

**A missing `iat` returns `null`, and the engine treats `null` as too old.** "We
cannot tell how recently you authenticated" is not evidence of a recent
authentication.

## Step-up authentication

Sensitive actions require a recently authenticated session. Default freshness is
15 minutes. Currently applied to:

`exchange.authorize` · `privilege.grant` · `audit.read.platform`

Step-up is evaluated **with the actor checks, before relationship and consent**.
Evaluating it later let a stale-but-valid session distinguish `REQUIRE_CONSENT`
from `ALLOW` and enumerate which patients had consent on file.

RBAC still precedes step-up: there is no point challenging re-authentication for
something the actor could never do.

## MFA

**No MFA provider is configured in this deployment.**

`MfaProvider` exists as an abstraction so step-up policy could be written and
tested now, and a real provider attached later without touching the engine.

The only implementation is `unconfiguredMfaProvider`. Every method returns
`NOT_CONFIGURED`, and **none of them can return `VERIFIED`** — asserted in the
test suite against several plausible responses, because a mock that reported
success would make every step-up policy in the system a lie.

The UI reports `MFA NOT CONFIGURED` and names the enforced mechanism as
`AUTHENTICATION_RECENCY`, so nobody reads the dashboard as "MFA is on".

## Session fixation

- Login mints a **new** cookie with the current token version and a fresh `iat`.
- `destroySession()` clears the cookie; pairing it with `revokeAllSessions`
  invalidates any copy held elsewhere.
- Role changes take effect immediately, because the role is re-derived from the
  database on every request.
- Facility can never be stale, because it is never in the cookie.

## What is still trusted

`AUTH_SECRET`. Rotating it invalidates every session at once — coarse, but an
effective revocation of last resort.
