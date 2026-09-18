# D5 — collections

Collection STATE is DERIVED from canonical commercial state + overdue invoices;
it is never a client-set field:

- SUSPENDED — subscription SUSPENDED
- SUSPENSION_RISK — GRACE with gracePeriodEndsAt within 3 days
- GRACE — GRACE otherwise
- PAST_DUE — subscription PAST_DUE
- ATTENTION — ACTIVE/other with an overdue unpaid invoice
- NORMAL — otherwise

`listCollections` (platform) returns organizations prioritized by state with
currency-grouped outstanding. Operators may record explicit CollectionActivity
notes (NOTE/CONTACT/PROMISE_TO_PAY/ESCALATION) which NEVER mutate invoices or
payments. Any real financial correction still goes through the authorized
credit/adjustment mechanism. Operators cannot mark an unpaid invoice paid,
fabricate a payment, bypass provider confirmation, alter totals, or delete
invoices. All activity is audited.
