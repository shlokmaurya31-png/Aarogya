/**
 * The consent service (D2). Every consent check in the product goes through
 * here:
 *   - lifecycle   request / grant / revoke / close / list / expire, and the
 *                 exchange guard (assertExchangeAuthorized) used by portal
 *                 sharing, HIE exchanges and FHIR export
 *   - evaluate    decideConsent, the one decision, plus evaluateConsent and
 *                 canSharePatientData for the authorization engine
 *   - delegation  family/caregiver access, used by the patient context and
 *                 everything built on it (portal reads, the AI assistant)
 * There is one consent model, InteropConsent.
 */
export * from "./lifecycle";
export * from "./evaluate";
export * from "./delegation";
