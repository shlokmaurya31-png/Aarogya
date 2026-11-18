/**
 * The tenancy sweep, run again after every other gate.
 *
 * verify:all runs scripts/verify-postgres-tenancy-sweep.ts first, on the seed
 * alone, and this last, over every row the other gates created (card shares,
 * access requests, linked Persons, visit codes redeemed across facilities…).
 * Both must pass: the sweep's result may not depend on the order of the gates.
 * It reuses the build the earlier HTTP gates made.
 *
 * Usage: through `npm run verify:all`.
 */
import "./lib/gateBootstrap";

process.argv.push("--no-build");
void import("./verify-postgres-tenancy-sweep");
