# Actions

Actions are populated from the **D7 action registry** (`builderMetadata().actions`) —
only actions that actually exist AND are `invokableFromDefinition` are offered:
`EMIT_DOMAIN_EVENT`, `UPDATE_WORKFLOW_STATE`. Task and timer creation are first-class
step types (TASK/TIMER), not raw actions.

The builder cannot add arbitrary clinical/financial actions: there is no
`ORDER_MEDICATION`, `POST_PAYMENT`, `GRANT_PERMISSION`, arbitrary API/webhook, SQL,
or code node. A workflow authored here can never become a privilege-escalation or
execution escape hatch (§28) — every action runs through its existing server-side
domain service with C4 authorization intact.
