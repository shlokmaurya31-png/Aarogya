# Operations

## API surface (§42)
No arbitrary execute endpoint. Reads use `workflow:read`; authoring uses
`workflow:manage` (service enforces org scope).

| Route | Purpose |
|---|---|
| `GET …/workflow-builder/metadata` | Triggers (D6) + actions/operators/limits (D7) |
| `GET …/workflow-builder/templates[/[id]]` | Starter templates |
| `POST …/workflow-builder/validate` | Structured validation report |
| `POST …/workflow-builder/simulate` | Side-effect-free simulation |
| `POST …/workflow-builder/diff` | Semantic diff |
| `GET/POST …/workflow-builder/drafts` | List / create-update drafts |
| `GET/DELETE …/workflow-builder/drafts/[id]` | Read / delete a draft |
| `POST …/workflow-builder/drafts/[id]/publish` | Compile + publish via D7 |
| `POST …/workflow-builder/import` | Import → DRAFT (never published) |
| `GET …/workflow-builder/export` | Export a portable document |

Publishing/versioning/retiring an existing definition also uses the D7 routes
(`…/enterprise/workflows/*`). The UI page is `/hospital-os/enterprise/workflows`.

## Audit (§31)
Authoring acts are audited: `workflow.builder.draftSaved/draftDeleted/imported/
exported/simulated/templateCopied`; publication reuses `workflow.published`. Canvas
interactions and effective lookups are not audited; no sensitive values are stored.

## Limits / performance (§43)
Document ≤ 64 KB; steps ≤ D7 `MAX_STEPS`; condition depth/nodes per D7 limits. The
pipeline renders a bounded node list (no thousands-of-nodes canvas).
