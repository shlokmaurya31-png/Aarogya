/**
 * A deposit/advance is simply a Payment with zero allocations — see
 * payments.ts's doc comment for why there is no separate Deposit model.
 * This file exists purely for discoverability (`billing/deposits.ts` is
 * where a reader looking for "deposits" will look first).
 */
export { recordPayment as recordDeposit } from "./payments";
