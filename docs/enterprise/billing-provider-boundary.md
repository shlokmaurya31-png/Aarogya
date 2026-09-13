# Billing provider boundary (Phase D2)

## No provider is integrated

D2 implements the commercial DOMAIN, not payment processing. There is **no**
Stripe/Razorpay/gateway integration, no webhook handler, no stored payment
credential, and no fabricated provider response. This is deliberate and matches
the D2 scope.

## The boundary that exists

`OrganizationSubscription.externalRef` (`String?`) is the single seam for a
future billing provider: an opaque reference to a provider-side subscription
object. It is never a secret and is never populated by D2 today.

A future provider adapter would conceptually implement:

```
createCustomer / createSubscription / cancelSubscription / syncSubscription / retrieveSubscription
```

and reconcile provider state into `OrganizationSubscription.status` via the
existing lifecycle service (`transitionSubscription`) — so the internal state
machine stays authoritative and audited regardless of the provider.

## Webhooks (deferred)

No provider webhooks are implemented. A real webhook handler requires a real
provider contract (signing secret, event schema, replay protection) and would be
built the way the Phase C ABDM/NHCX callbacks were: an unauthenticated inbound
arrival, verified and idempotently applied. It is documented here as the future
boundary only — nothing speculative was built.

## What a future provider must NOT change

- Entitlement remains a separate layer from authorization (see
  [commercial-authorization](commercial-authorization.md)).
- Commercial state must never gate safety-critical clinical access.
- The internal lifecycle state machine and its audit trail stay authoritative;
  the provider is a source of billing events, not a bypass.
