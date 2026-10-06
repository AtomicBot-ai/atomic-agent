# Agent configuration

Status: current
Owner: src/config/agent/

Read the parent [instructions](../AGENTS.md) and [compatibility guide](../docs/compatibility.md).

[agent-types](agent-types.ts) separates the stored user policy from runtime-only settings. [agent-defaults](agent-defaults.ts) constructs fresh defaults and uses the existing [execution policy defaults](../agent-execution-config.ts). [agent-parser](agent-parser.ts) owns budget/read-scope/approval validation and delegates task/provider waiting to that existing owner. The whole-file [schema](../config-schema.ts) supplies current mutable defaults, accepts versions and preserves compatible public exports.

No runtime resources or approval decisions are owned here. Dispatch guards belong to [approval](../../approval/README.md) and [read-scope tools](../../tools/read-scope/read-scope.ts); prompt budgeting and task execution consume validated values. Read [execution and resource configuration](../docs/execution-resource.md) for evaluation order, migration and reference semantics.

Checks: `npx vitest run src/config/agent src/config/config-schema.test.ts src/config/agent-execution-config.test.ts`; `npm run lint`; `npm run typecheck:tests`; `npm run imports:check`. Include the affected prompt/approval/task seams when changing policy behavior.
