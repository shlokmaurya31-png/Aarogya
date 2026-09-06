/**
 * Phase 5: the charge engine moved to billing/chargeCapture.ts as part of
 * the full billing/insurance/revenue-cycle subsystem — see
 * docs/PHASE_5_BILLING_ARCHITECTURE.md. This file is a thin re-export shim
 * so existing call sites (orders/lab, orders/imaging) don't need an
 * import-path change, only updated arguments (chargeCode-based pricing
 * instead of a raw amount).
 */
export { createCharge, createChargeIfNotExists, createPricedChargeIfNotExists, voidCharge, ChargeAlreadyInvoicedError } from "./billing/chargeCapture";
