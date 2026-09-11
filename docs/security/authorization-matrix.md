# Authorization Matrix

Decisions produced by `authorizeAccess()`. These are **Aarogya technical access
policies**, not legal conclusions.

Legend — **Fac**: facility boundary applies · **Rel**: minimum relationship ·
**Cons**: consent required · **BG**: break-glass eligible · **Step**: step-up
required.

## By action

| Action | Permission | Fac | Rel | Purpose | Cons | Cred/Priv | BG | Step | Class |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `patient.read` | `patient:read` | ✅ | FACILITY_STAFF | any | ❌ | — | ✅ | ❌ | STANDARD |
| `patient.timeline.read` | `patient:read` | ✅ | FACILITY_STAFF | any | ❌ | — | ✅ | ❌ | SENSITIVE |
| `document.read` | `patient:read` | ✅ | FACILITY_STAFF | any | ❌ | — | ✅ | ❌ | SENSITIVE |
| `document.read.restricted` | `document:manage` | ✅ | **DIRECT_CARE** | any | ❌ | — | ✅ | ❌ | **HIGHLY_SENSITIVE** |
| `patient.export.fhir` | `interop:fhir:export` | ✅ | FACILITY_STAFF | 6 listed | **✅** | — | **❌** | ❌ | HIGHLY_SENSITIVE |
| `exchange.request` | `interop:exchange:request` | ✅ | FACILITY_STAFF | 6 listed | **✅** | — | **❌** | ❌ | HIGHLY_SENSITIVE |
| `exchange.authorize` | `interop:exchange:authorize` | ✅ | FACILITY_STAFF | any | **✅** | — | **❌** | **✅** | HIGHLY_SENSITIVE |
| `billing.export` | `billing:invoice:create` | ✅ | FACILITY_STAFF | INSURANCE/OPERATIONS/PATIENT_ACCESS | **✅** | — | ❌ | ❌ | FINANCIAL |
| `breakglass.activate` | `patient:read` | ✅ | FACILITY_STAFF | any | ❌ | — | ❌ | ❌ | SECURITY |
| `breakglass.review` | `hospital:admin:manage` | ✅ | — | any | ❌ | — | ❌ | ❌ | SECURITY |
| `audit.read.facility` | `hospital:admin:manage` | ✅ | — | any | ❌ | — | ❌ | ❌ | SECURITY |
| `audit.read.platform` | `admin:verification:manage` | ❌ | — | any | ❌ | — | ❌ | **✅** | SECURITY |
| `privacy.request.create` | — | ✅ | — | any | ❌ | — | ❌ | ❌ | IDENTITY |
| `privacy.request.read` | — | ✅ | — | any | ❌ | — | ❌ | ❌ | IDENTITY |
| `privacy.request.review` | `hospital:admin:manage` | ✅ | — | any | ❌ | — | ❌ | ❌ | IDENTITY |
| `identity.external.link` | `interop:identifier:manage` | ✅ | FACILITY_STAFF | any | ❌ | — | ❌ | ❌ | IDENTITY |
| `credential.verify` | `credential:verify` | ✅ | — | any | ❌ | maker/checker | ❌ | ❌ | SECURITY |
| `privilege.grant` | `privilege:grant` | ✅ | — | any | ❌ | no self-grant | ❌ | **✅** | SECURITY |
| `patient.self.read` | `patient:self:read` | ❌ | **PATIENT_SELF** | any | ❌ | — | ❌ | ❌ | STANDARD |

## By role

What each role can reach, and — more importantly — what it cannot.

| Role | Clinical read | Restricted docs | Export / exchange | Break-glass | Credentialing | Audit |
| --- | --- | --- | --- | --- | --- | --- |
| **PATIENT** | own record only | ❌ | own record (PATIENT_ACCESS) | ❌ | ❌ | ❌ |
| **DOCTOR** | in-facility | with DIRECT_CARE or break-glass | request + export, **consent required** | ✅ activate | ❌ | ❌ |
| **NURSE** | in-facility | with DIRECT_CARE or break-glass | ❌ | ✅ activate | ❌ | ❌ |
| **LAB_TECHNICIAN** | in-facility | ❌ (no `document:manage`) | ❌ | ✅ activate | ❌ | ❌ |
| **RADIOLOGY_TECH** | in-facility | ❌ | ❌ | ✅ activate | ❌ | ❌ |
| **PHARMACIST** | in-facility | ❌ | ❌ | ✅ activate | ❌ | ❌ |
| **BILLING_STAFF** | ❌ clinical | ❌ | financial only, consent required | ❌ | ❌ | ❌ |
| **FRONT_DESK** | in-facility (registration) | ❌ | ❌ | ❌ | ❌ | ❌ |
| **PROCUREMENT_OFFICER** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **HOSPITAL_ADMIN** | in-facility | with DIRECT_CARE or break-glass | full, **consent + step-up** | ✅ review/revoke | ✅ maker/checker | facility only |
| **AAROGYA_ADMIN** | ⚠️ see below | **❌** | ❌ | ❌ | ❌ | platform, **step-up** |

### AAROGYA_ADMIN is not a clinical superuser

This is the row most likely to be assumed wrong, so it is stated explicitly.

`AAROGYA_ADMIN` resolves to relationship `PLATFORM_ADMIN`, which ranks **below**
`FACILITY_STAFF` in the relationship ordering. It therefore does **not** satisfy
`document.read.restricted` (needs `DIRECT_CARE`) and cannot obtain it through
break-glass, since break-glass requires an active staff profile in the facility
and a platform admin has none.

Platform administration and clinical authorization are deliberately separate
axes. Verified in `scripts/verify-postgres-trust-layer.ts`.

## Consent vs authorization — worked examples

| Scenario | Authorization | Consent | Result |
| --- | --- | --- | --- |
| Doctor reads an in-facility chart | ✅ FACILITY_STAFF | not required | **ALLOW** |
| Doctor reads a RESTRICTED doc, no care relationship | ✅ RBAC, ❌ relationship | n/a | **REQUIRE_BREAK_GLASS** |
| Same, under an active break-glass window | ✅ via break-glass | n/a | **ALLOW**, `viaBreakGlass` |
| Doctor exports to an external org, no consent | ✅ | ❌ | **REQUIRE_CONSENT** |
| Doctor exports, consent for a different purpose | ✅ | ❌ purpose | **REQUIRE_CONSENT** |
| Doctor exports, consent for a different recipient | ✅ | ❌ recipient | **REQUIRE_CONSENT** |
| Doctor exports, consent scope narrower than request | ✅ | ❌ scope | **REQUIRE_CONSENT** |
| Foreign-facility actor with a perfectly valid consent | ❌ facility | ✅ | **CONFLICT** ("Not found.") |
| Patient reads own record | ✅ PATIENT_SELF | not required | **ALLOW** |
| Stale session authorizes an exchange | ❌ recency | not reached | **REQUIRE_STEP_UP_AUTH** |
| Suspended staff, every permission | ❌ staff status | n/a | **DENY** |

The pattern worth internalising: **authorization and consent both have to pass,
and neither can rescue the other.**
