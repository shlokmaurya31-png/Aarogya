# Conditions

The condition builder reuses the **D7 condition engine** — there is no new expression
language. It produces canonical D7 condition JSON: `all` / `any` / `not` groups of
leaf rules `{ field, operator, value }` over the allow-listed context.

Operators (from D7): `equals, not_equals, in, not_in, exists, not_exists,
greater_than, greater_than_or_equal, less_than, less_than_or_equal, contains`.

The UI never accepts an arbitrary expression string. It enforces backend limits
(nesting depth, node count, value/array size, operator availability) as advisory
hints, and the **D7 validator re-enforces them server-side** on save/publish (§9).
A value like `'; DROP TABLE …` is inert data — it is compared in memory, never
interpolated into a query.
