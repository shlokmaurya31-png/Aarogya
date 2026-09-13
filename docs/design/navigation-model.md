# Aarogya Navigation Model

Navigation follows **user mental models by role**, not database structure. Each persona
sees what its job needs - not one universal menu exposing everything.

## Current state (good bones)
`HospitalShell` already implements **role-based nav** via `NAV_BY_ROLE` for
`HOSPITAL_ADMIN`, `DOCTOR`, `NURSE`, `LAB_TECHNICIAN`, `RADIOLOGY_TECH`, `PHARMACIST`,
`PROCUREMENT_OFFICER`, `BILLING_STAFF`, `FRONT_DESK`, `AAROGYA_ADMIN`, with nested
groups (Diagnostics, Billing, Inventory). Active state uses the brand accent. This is
the right pattern and is preserved.

Separate app shells exist per surface: `admin`, `patient`, `student`, `hospital`,
`lab`, `educator`, plus `select-app` as the switcher. Keep these boundaries.

## Personas & primary needs
| Persona | Most frequent | Primary nav home |
|---------|---------------|------------------|
| Patient | Records, appointments, prescriptions | Patient app |
| Doctor | My patients, ED board, orders | `hospital-os/doctor` |
| Nurse | My shift, tasks, vitals | `hospital-os/nurse` |
| Pharmacist | Dispense queue, stock | `hospital-os/pharmacy` |
| Lab tech | Lab queue | `hospital-os/lab` |
| Radiology | Imaging queue | `hospital-os/radiology` |
| Billing | Encounters, claims | `hospital-os/billing` |
| Hospital admin | Command center, all domains | `hospital-os` |
| Procurement/Inventory | Stock, procurement | `hospital-os/inventory` |
| Operations/Quality | Operations, security | `hospital-os/operations` |
| Aarogya admin | Cross-facility control | `hospital-os` / `admin` |

## Navigation layers
1. **Primary** - role sidebar (desktop) / drawer (mobile). Reuse `NAV_BY_ROLE`.
2. **Secondary** - nested groups (Diagnostics/Billing/Inventory) - already present.
3. **Contextual** - patient/facility context header on clinical pages
   (`PatientHeader`, sticky where scanning a long chart).
4. **Global actions** - search / command bar, notifications, alerts, theme, sign-out.

## Required changes
- **P1 - Mobile navigation** (see [`design-debt.md`](./design-debt.md) #2): add a
  `Topbar` + slide-in `MobileNav` drawer below `lg`, driven by the same role map. Below
  `lg` there is currently **no** navigation.
- **Global search / command bar**: a keyboard-first (`⌘K`) command palette for the
  dense HOS surface - jump to patient/worklist/action. Deferred to a later phase.
- **Facility context**: surface `facilityName` (already passed to the shell) in the
  mobile topbar too.

## Rules
- Never expose a route a role can't use. Nav is a UX courtesy layered over - not a
  replacement for - the server-side auth boundary (`HospitalOsLayout` role guard).
- Active state = `brand` (`bg-brand-subtle text-brand`); hover = `bg-fill-hover`.
