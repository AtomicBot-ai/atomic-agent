# Frontend, channel and integration configuration

Status: current
Owner: src/config/

Read [config instructions](../AGENTS.md) and [compatibility](compatibility.md) before changing these stored settings. Root [config-schema](../config-schema.ts) owns version acceptance, whole-file assembly and the compatible public API. These owners validate settings without constructing interfaces, sending messages, resolving secrets or starting services.

## Owners and entry points

- [tui-config](../tui-config.ts) owns appearance/input, onboarding and terminal notification types, fresh defaults and parsing. [Adjacent tests](../tui-config.test.ts) cover default capture and the composition seams. Session ordering uses the existing [session-rail owner](../session-rail-config.ts).
- [channel-config](../channel-config.ts) owns Telegram, Discord and swarm settings, default factories, identity validation and normalization. [Adjacent tests](../channel-config.test.ts) cover owner migration, array rules, validation order and default lookups. Connection, pairing and delivery remain with [channels](../../channels/README.md).
- [integration-config](../integration-config.ts) owns download-notification, Atomic Mail, Git remote-sync and Composio settings. [Adjacent tests](../integration-config.test.ts) cover retained references, nullable values, defaults and error ordering. Live operations remain with [notifications](../../notifications/README.md), [Atomic Mail](../../atomic-mail/README.md), [Composio](../../composio/README.md) and [OS Git tools](../../tools/os/README.md).

The shared trimmed nullable-string validator belongs to [config-values](../config-values.ts), alongside URL/list validators. Config owners depend inward on concrete scalar/value/error helpers; TUI config additionally uses session-rail. They do not import each other or the composing schema. There is no separate defaults cache or mandatory barrel API.

## Assembly and mutable defaults

Root retains raw references at their original early positions. In particular, notification downloads are captured before local-model validation and passed to the late notification parser. Replacing the raw downloads block later in the same call does not replace that retained reference.

Late normalization preserves TUI → analytics → Telegram → Discord → swarm → notifications → mail → Git → Composio → MCP order. Analytics remains its own small root section. Error precedence across those settings follows this order; grouping ownership does not make validation eager.

Outer TUI and channel/integration fallback expressions read the current defaults separately at their original positions. Onboarding and terminal notification helpers instead capture their selected nested defaults once upon entry. Root keeps the existing one-argument `parseOnboardingState` and `parseTuiNotify` as thin wrappers that supply those defaults explicitly. The other existing pure parsers and swarm ID regex are compatible re-exports.

Absent/null onboarding or notify returns a fresh spread of the selected default, including its enumerable extension keys, without validating it. Present onboarding validates its fields; absent timestamp fields become null independently of mutated defaults. Present notify uses the captured nested default for both fields. No global initialization hook, freeze or cache is added.

## Preserved validation boundaries

Discord's present owner list wins over the legacy scalar even when empty; missing/null lists fall back to that scalar. Only the scalar is trimmed. Lists retain stable deduplication and string snowflake validation. Telegram keeps its existing numeric-string conversion. Swarm arrays preserve sparse holes and validate owner ID before enabled, while retaining the previous output property order. Disabled settings still validate their other fields.

Missing Discord owner lists and swarm units do not inherit mutable default arrays. Mail fields ignore mail defaults and normalize raw nullable strings. Composio cached IDs/URL similarly have no default fallback or new UUID/URL validation. Pending verification retains its existing required-string checks and attempt handling; service validation remains separate. A direct null download channel becomes null, while root null uses its current configured fallback. Git parsing validates its switch without performing Git operations or modifying approval policy.

## Checks

Run `npx vitest run src/config`, affected channel/integration/TUI persistence and notification seams, `npm run lint`, `npm run typecheck:tests`, `npm run imports:check` and `npm run docs:check`. Config parsing tests do not require real service credentials or message delivery. Full local CI and existing environment-dependent fixtures are described in [local verification](../../../docs/testing/local-ci.md).
