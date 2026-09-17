# D4 — provider verification matrix

No Razorpay credentials exist in this repository. The adapter is real,
contract-accurate code verified offline with an injected transport and a known
webhook secret; no live call has ever been made.

| Capability                   | Status                |
| ---------------------------- | --------------------- |
| Billing domain               | VERIFIED              |
| Provider abstraction         | VERIFIED              |
| Provider adapter (Razorpay)  | VERIFIED (adapter logic; offline) |
| Provider sandbox credentials | NOT AVAILABLE         |
| Sandbox connectivity         | BLOCKED               |
| Customer creation            | BLOCKED (live) — adapter VERIFIED |
| Payment creation             | BLOCKED (live) — adapter VERIFIED |
| Payment verification         | BLOCKED (live) — webhook signature + capture logic VERIFIED |
| Refund                       | BLOCKED (live) — adapter + idempotency VERIFIED |
| Webhook signature            | VERIFIED              |
| Webhook replay protection    | VERIFIED              |
| Reconciliation               | VERIFIED              |
| Dunning                      | VERIFIED              |
| Production credentials       | NOT AVAILABLE         |
| Production connectivity      | BLOCKED               |
| Production readiness         | NOT READY             |

Nothing above is marked VERIFIED because a mock returned success: FAKE-provider
results verify the domain wiring, and the Razorpay adapter's own logic is verified
against documented request/response shapes and real HMAC signatures. Live
connectivity remains BLOCKED until credentials are configured.

## To reach SANDBOX VERIFIED / PRODUCTION READY
Configure `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`
(sandbox first) in the environment, register the webhook endpoint, then run a real
create-order → checkout → payment.captured cycle and a real refund against the
Razorpay sandbox. Only after that may sandbox rows in this matrix change to
VERIFIED; production requires the same against live credentials.
