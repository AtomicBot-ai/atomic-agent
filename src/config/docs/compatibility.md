# Configuration defaults and compatibility

Status: current
Owner: src/config/

## Authority

`USER_CONFIG_DEFAULTS`, `parseUserConfigFile` and `loadConfig` are the current authority for defaults, migration and precedence. The schema version at this documentation migration is 74; documentation-only changes do not bump it. Inspect the source rather than reconstructing defaults from historical rollout phases.

The checked primitive-value snapshots live in [user defaults](user-defaults.md) and [operational/helper defaults](operational-defaults.md). Read only the relevant surface for a defaults change.

Current checked examples: localModels mode=external, thinking=auto, reasoningBudgetTokens=1500, completionMaxTokens=16384; agent tokenBudget=3000 and maxSteps=25, with task-wide maxSteps=1000/maxDurationMs=7200000 and autoContinue=true. These are different budgets, not a promise that every task ends after 25 steps.

Memory embeddings are off by default; query rewriting, links, evolution, lessons/procedures/consolidation/voting are enabled. Typed notes, reflection segmentation and anySpeaker are disabled. Retention is disabled by default. Environment overrides and migrations can make an existing install differ.

## Scalar validation

[config-primitives](../config-primitives.ts) owns the shared scalar validators. The composing schema re-exports the same parser functions and the existing [error class](../config-validation-error.ts); function and error identity are preserved. This module does not load defaults, migrations or the root API.

Numeric strings must parse completely: decimal and exponent forms remain accepted, trailing garbage and unsafe integer strings are rejected. Numeric integer inputs retain the existing different safe-range treatment. The float syntax also accepts leading plus signs, `.5` and `1.`; it is not restricted to JSON lexical syntax. Boolean string aliases are case-insensitive without whitespace trimming; nonempty strings preserve whitespace, including whitespace-only values. Null/undefined handling belongs to the selected parser or domain caller. [load-config](../load-config.ts) intentionally keeps its separate environment fallback/clamping behavior.

## Session rail layout

[session-rail-config](../session-rail-config.ts) validates the stored order and pinned lists independently of session storage. Missing/null blocks or lists produce fresh empty arrays; a present nonobject block or nonarray list is rejected with the existing field-specific error. Nonstring and empty entries are dropped; duplicate ids keep their first position. Whitespace-only strings remain ids at this layer. The composing schema preserves its type/parser exports, defaults and version handling. Actual session existence and stale-id cleanup belong to the TUI persistence/display path.

## Webhook configuration

Webhook map parsing belongs to [webhook-config](../webhook-config.ts); root config exports and assembly remain compatible. Absent/null maps are empty. Normalized entries default to ephemeral mode; named mode requires a sessionId. Optional cleared secrets/session ids/schedules remain absent, while explicit empty strings retain their existing validation errors. Template strings preserve whitespace and accepted webhook names allow letters, digits, underscores and hyphens.

Schedule parsing checks and normalizes at/interval/cron shapes without importing cron-parser or task execution. A positive interval below the execution minimum and a nonempty invalid cron expression can load; [canonical task validation](../../tasks/task-schedule.ts) rejects them when a task is created. Config loading must not acquire dispatch-time policy or resources through this extraction.

## Shared values and MCP servers

[config-values](../config-values.ts) owns URL validation that returns the original string and nullable string lists without normalization/deduplication. Non-HTTP URL schemes and surrounding URL whitespace retain their existing acceptance/bytes. Null/undefined lists become null, while empty lists remain lists. These are configuration validators, not network/read-scope/SSRF policies.

[mcp-server-config](../mcp-server-config.ts) uses these values and the neutral MCP type/name constants. Existing namespace regex and length bounds remain authoritative, including the current refusal of one-character names. Only absent enabled defaults to true; explicit null is invalid. Null stdio args are omitted, empty args lists/maps are retained, and list order/duplicates/whitespace remain. Env identifiers and RFC header tokens have different key rules; empty string values remain valid. Optional trust is omitted instead of assigning a new default. Remote env fields remain accepted as before, regardless of client usage. Server parsing performs no connection or environment forwarding; those contracts belong to the MCP client.

## Agent execution policies

[agent-execution-config](../agent-execution-config.ts) owns task and provider-wait shapes, fresh default construction and parsing. Root assembly retains the exported mutable USER_CONFIG_DEFAULTS object. Each parser receives its current nested default object explicitly: missing/null blocks return that same reference; present objects produce fresh normalized results using current values. Mutating or replacing nested defaults, or replacing the whole agent block between calls, remains visible to the next parse. No cached nested defaults, clones on absence or freezes are introduced.

Scalar null fields use the existing fallback; explicit false and accepted numeric/boolean strings retain their semantics. A zero maxWaitMs is still rejected even when waiting is disabled. Config does not clamp task.maxSteps to the leg ceiling; that execution policy belongs to the agent loop. Non-array objects retain their existing acceptance, and unknown fields in present policy blocks are discarded. Public root types preserve the same structural fields and existing exported names. Runtime overrides, outage-budget reset and task termination are unchanged.

## Web search and fetch

[web-config](../web-config.ts) owns configuration types, fresh defaults, provider/fallback validation and search/fetch normalization. Root keeps two phases: provider and provider-settings references are prepared before webhook/local-model/LLM validation; remaining search fields normalize after agent/HTTP, followed by fetch. This order determines the first reported error when several inputs are invalid. A single early whole-web parser would change that contract.

Each fallback expression reads current defaults through an explicit lookup, preserving short-circuiting and within-call default replacement. Search/fetch output and nested provider settings remain fresh. Missing searxng.instanceUrl becomes null independently of its default. Repeated getter reads and permissive field lookup are preserved: primitive, array and class blocks without relevant fields can still normalize to defaults. Direct fallback parsing distinguishes undefined from null; whole-file null uses the default and an explicit empty list suppresses fallback.

Endpoint and API-key-env strings retain nonempty-string validation, including whitespace and non-URL values. Disabled search still validates its configuration. No new timeout/retry cross-field constraints, provider construction, credential lookup, network operation or cache persistence occur during parsing. Runtime search orchestration, fetch retries/SSRF checks and configless fetch defaults remain with their existing tool owners.

## Memory configuration

[Memory configuration](../memory/README.md) owns all stored memory policy blocks, with separate ordered runtime/user types, fresh default construction and parsing. Root keeps overall version acceptance and early/late assembly positions. Preparation retains raw subblock references without validation; normalization stays after session retention/tracing and before vision/frontend settings. Current defaults are looked up per expression, preserving short-circuiting, within-call replacements and repeated reads.

Seven feature flags retain pre-v22 forcing to enabled, even for explicit false or malformed flags; their current-default arguments are still evaluated before the helper. From v22 they validate the supplied value or default. Other enabled fields retain their own policy. Three sub-call timeouts use the unchanged [shared migration helper](../subcall-timeout-migration.ts): exact historical defaults in pre-v65 files adopt current defaults, while different operator pins remain. Scalar validation precedes that migration, and the existing repeated current-default lookups remain.

Outputs and nested objects are fresh. Permissive field lookup, discarded unknown nested fields, null/list behavior and current positive/nonnegative/ratio bounds are unchanged; profile.maxEntries still rejects zero. Disabled subsystems validate their other fields. No new weight normalization, capacity clamp, storage operation, provider call or prompt change occurs during config parsing.

## Local model configuration

[Local model configuration](../local-models/README.md) owns types, fresh defaults, validators and domain migrations. Root keeps whole-file acceptance and the LLM-provider assembly seam. Early validation proceeds through same-file custom models, managed settings, embedding port before enabled, downloads, mode and URL. Completion/template/thinking/reasoning fields normalize after provider composition. Combining those phases changes error precedence and is not a mechanical extraction.

Current defaults are read separately at each old fallback expression, retaining short-circuiting and within-call nested/whole-default replacements. Pre-v41 auto-update returns true without reading a default, including malformed supplied values. Explicit parallel auto also bypasses defaults; only the historical pre-v63 pinned value follows its existing migration. Tensor split/custom-model arrays ignore mutated defaults, and absent embedding URL uses the validated embedding port. Unknown nonempty embedding model IDs remain accepted; managed IDs use the catalog or parsed same-file custom definitions.

User/runtime shapes remain separate. Outputs/default factories have fresh nested objects and arrays. Disabled/external modes still validate all settings; positive ports retain their current bounds, URLs retain general scheme acceptance, and Hugging Face normalization retains path prefixes. No new network/process/filesystem operation, trimming policy, migration or default is introduced. Environment precedence, catalog publication after loading and live server ownership stay with their existing owners.

## Frontend, channel and integration settings

[TUI, channel and integration owners](frontend-integration.md) retain late normalization and separate resource ownership. TUI helpers capture onboarding/notify defaults once on entry, after evaluating their raw arguments; absent/null returns a fresh spread while present blocks retain validation. Root keeps the existing one-argument wrappers. Outer fallback expressions continue reading current defaults separately; raw notification downloads retain their early captured reference.

Discord's present owner list wins over the legacy scalar regardless of file version, including an explicit empty list; only the scalar is trimmed. Telegram numeric strings retain Number conversion. Swarm retains duplicate-id/token checks, sparse array behavior and owner-before-enabled validation. Missing owner/unit arrays ignore mutated default arrays. Mail and Composio nullable cached fields have no new default fallback, format validation or service operation. Download channel direct-null and whole-file default fallback remain distinct; Git parsing leaves execution/approval policy to tools.

## Writes and credentials

Preserve validation of provider/model pins and run mode. Writes that change user config must reset the cache as required by the existing API. Credential storage uses owner-only files and platform-specific ACL handling; missing optional credentials and required credentials have different behavior.

## Sources and tests

- [Defaults/parser](../config-schema.ts), [precedence](../load-config.ts), [file writes](../config-file.ts), [cache](../config-cache.ts), [owner-only files](../owner-only-file.ts).
- [Schema tests](../config-schema.test.ts), [LLM config](../llm-config.test.ts), [run-mode config](../llm-run-mode-config.test.ts).

## Execution and resource policies

[Concrete owners](execution-resource.md) separate full agent, outbound HTTP, project/shell/vision, skills, retention and tracing configuration from execution. Root retains version history and ordered assembly, including the early telemetry/tracing merge. Explicit default callbacks preserve conditional scalar reads, eager policy/retention arguments and captured ClawHub defaults. Read the linked guide before changing those mechanisms; moving settings does not grant broader tool access or change resource lifetime.
