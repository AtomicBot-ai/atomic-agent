# Execution, tool and resource configuration

Status: current
Owner: src/config/

The [whole-file schema](../config-schema.ts) owns version acceptance, raw-input preparation, environment constants and ordered assembly. Concrete owners receive explicit callbacks to current defaults. They neither load global configuration nor acquire execution resources. Read [compatibility](compatibility.md) before changing these policies.

## Owners and consumers

- [Agent policy](../agent/README.md): runtime/user types, budgets, read scope and approval; [task/provider waiting](../agent-execution-config.ts) remains its existing owner. [Tests](../agent/agent-config.test.ts) pin eager argument reads, fallback and reference semantics.
- [Outbound HTTP](../http-config.ts): user/runtime types and v25 approval migration. It configures [HTTP requests](../../tools/os/web/http-request.ts), separately from the inbound [HTTP server](../../http/README.md).
- [Tool settings](../tool-config.ts): separate projects, shell and vision defaults/parsers. Discovery, process/job lifetime, security guards and inference remain [tool operations](../../tools/README.md). [Tests](../tool-policy-config.test.ts) include HTTP migration and the original nonadjacent assembly positions.
- [Skills](../skills-config.ts): catalog budget, disabled names, taps and ClawHub settings. Installation/discovery belongs to [skills](../../skills/README.md); changing catalog contents still invalidates the stable prompt prefix through existing consumers.
- [Session retention](../session-retention-config.ts): enabled/age/row settings; deletion remains [session retention](../../session/session-retention.ts).
- [Tracing](../tracing-config.ts): nullable recording toggle and file cap; writer/rotation/lifetime belong to [tracing](../../tracing/README.md). Runtime trace directory is absent from the user type. [Resource tests](../config-resource.test.ts) cover skills, retention and tracing.

## Evaluation and compatibility

Scalar defaults are read per expression after the raw getter. Agent task/provider-wait defaults are evaluated even when a raw policy is present; absent policies retain the supplied default reference. Approval evaluates both new-level and legacy-boolean arguments before choosing: a nonnull level wins, otherwise the boolean maps false to 5 and true to 1, otherwise the current default is returned. This is presence-driven on every accepted version. No new task/model cap is imposed by config.

Before v25, missing/null/writes HTTP approval mode becomes literal never without reading that default. Explicit always/never and v25+ values retain their old validation. Disabled blocks still validate their other fields. Host/project lists preserve whitespace, duplicates and order; config validation does not perform network/path/security checks. Shell zero timeout remains accepted; independent limits are not coupled.

Retention distinguishes absence from explicit null: absence uses the supplied cap, null disables that rule. The fallback argument is nevertheless eagerly read in both cases. ClawHub captures its selected nested defaults once at entry; absent input returns a fresh spread, while a present block validates into a fresh known-field object. The public root one-argument wrapper preserves that behavior. Skill/tap deduplication is unchanged. Disabled-name configuration accepts one-character skill names for cloud compatibility; the native local manifest parser retains its existing validation.

`skills.cloudWorkspaces` defaults to `[]`. Entries require `workingDir` and default to `projectSkillsEnabled: true`, `disabled: []`; duplicate workspace keys are rejected. Canonicalization belongs to [policy commands](../skill-policy-commands.ts), not schema parsing. These policies live in user config and apply only to cloud sessions in that workspace. Global `skills.disabled` wins over workspace settings. Cloud preparation and special skill tools reread the file to observe external changes without restarting. See [cloud controls](../../skills/docs/cloud-workspace.md).

Early raw shell/retention references and the telemetry/tracing merge stay in the schema. Legacy trace properties are spread first, current properties last, before late validation; a current undefined property still replaces the legacy value before default fallback. Parsers remain at their original late positions, so cross-domain error precedence is preserved.

Default factories return fresh mutable literals, without cached bundles or freezing. Consumers can keep existing root imports; new internal code should use the actual owner. Public shape/version/environment precedence and persisted JSON remain compatible. Root intentionally retains bootstrap/version history/unknown-key handling, small log/analytics blocks and three default-dependent compatibility wrappers.

## Checks

Run `npx vitest run src/config`, affected approval/read-scope/prompt/tool/skills/session/tracing seams, `npm run lint`, `npm run typecheck:tests`, `npm run imports:check`, `npm run docs:check` and `npm run test:ci`. Import gates prohibit owners from depending on the composing schema, frontends or execution; agent type imports remain type-only.
