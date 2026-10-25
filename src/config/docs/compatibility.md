# Configuration defaults and compatibility

Status: current
Owner: src/config/

## Authority

`USER_CONFIG_DEFAULTS`, `parseUserConfigFile` and `loadConfig` are the current authority for defaults, migration and precedence. The current schema version is 79; documentation-only changes do not bump it. Inspect the source rather than reconstructing defaults from historical rollout phases.

The checked primitive-value snapshots live in [user defaults](user-defaults.md) and [operational/helper defaults](operational-defaults.md). Read only the relevant surface for a defaults change.

Current checked examples: localModels mode=external, thinking=auto, reasoningBudgetTokens=0 (no bound), completionMaxTokens=16384; agent tokenBudget=3000 and maxSteps=25, with task-wide maxSteps=1000/maxDurationMs=7200000 and autoContinue=true. These are different budgets, not a promise that every task ends after 25 steps.

Memory embeddings are off by default; query rewriting, links, evolution, lessons/procedures/consolidation/voting are enabled. Typed notes, reflection segmentation and anySpeaker are disabled. Retention is disabled by default. Environment overrides and migrations can make an existing install differ.

## Cloud model mode migration

For input versions below 75, validated providers without `modelMode` receive `cloud` when the shared [provider classification](../model-mode.ts) recognizes a cloud service. This uses the same rule as adding a connection. Explicit `local`/`cloud` settings and per-model overrides remain intact; local and unknown endpoints are left as they were. Null is parsed as absent before migration. Provider IDs, models, credentials and numerical limits are not changed by this migration.

[Config loading](../config-file.ts) persists the upgraded version through its existing atomic owner-only writer. Read-only parsing returns migrated values without writing. Version 75 or newer does not reapply classification: manual `local` or `inherit` choices survive later loads and provider edits. A missing version follows the existing current-version rule. [Mode tests](../model-mode.test.ts), [file IO tests](../config-file.test.ts) and [provider commands](../llm-provider-commands.test.ts) cover classification, persistence, restart and manual precedence.

## Atomic Core default engine migration

Version 77 makes `atomic-core` the default `localModels.managed.engine`. Before it the Atomic Core choice sat behind an opt-in environment variable, so a stored `llama-server` was the written default rather than a decision: for input versions below 77 a missing or `llama-server` engine becomes `atomic-core`. Nothing else in the file changes, including external mode and every other managed field. From version 77 an explicit `llama-server` is honoured, so switching back with `models engine llama-server` survives later loads. Unknown engine values still fail validation. [Local model config tests](../local-models/local-models-config.test.ts) cover the migration.

## Reasoning budget default migration

Version 78 sets the default `localModels.reasoningBudgetTokens` to `0`, no bound, as it was before version 68. llama.cpp clamps a grammar repetition to 1,999 characters, so the old default of 1500 tokens was really 499 and cut thinking models off mid-thought. Every file since version 68 carries the value the schema wrote, so for input versions below 78 a stored value of exactly `1500` is read as that default and becomes `0`. Any other value, including a lower positive bound, is kept, and a missing field takes the new default. From version 78 an explicit `1500` is honoured. [Local model config tests](../local-models/local-models-config.test.ts) cover the migration.

## Outbound HTTP approval migration

Version 79 makes `"writes"` the default `http.approvalMode` again: an `os.http.request` that sends a body (POST) goes through the approval gate, a GET does not. Version 25 had made `"never"` the default, so a model steered by a hostile page or file could send the user's data anywhere without a prompt (ATO-760). Every first run writes the full defaults and the v25 migration rewrote `"writes"` to `"never"`, so a stored `"never"` in a file older than 79 is the schema's value, not a choice: it becomes `"writes"`. `"always"` and `"writes"` are kept and a missing value takes the default. From version 79 an explicit `"never"` is honoured. A GET can still carry data out in its URL; the approval level ladder (`http` stops asking from level 3) is unchanged. [Tool policy config tests](../tool-policy-config.test.ts) cover the migration.

## External llama.cpp URL default

The default `localModels.url` is `http://127.0.0.1:9931`, llama-server's own default port since llama.cpp v0.7.0; it was `http://127.0.0.1:8080` before. This is a default change with no migration and no version bump. Every first run writes the full defaults, so existing files carry `8080` whether or not anyone chose it, and a stored `8080` cannot be told apart from a deliberate pick: the official Docker images and older llama-server builds still listen there. Stored values are therefore kept, and only a file with no `url` takes the new default. The first-run check reads both `9931` and `8080` on the external path as an untouched default, and the unreachable hint names both ports for a loopback URL on either.

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

[mcp-server-config](../mcp-server-config.ts) uses these values and the neutral MCP type/name constants. Existing namespace regex and length bounds remain authoritative, including the current refusal of one-character names. Only absent enabled defaults to true; explicit null is invalid. Null stdio args are omitted, empty args lists/maps are retained, and list order/duplicates/whitespace remain. Env identifiers and RFC header tokens have different key rules; empty string values remain valid. Optional trust is omitted instead of assigning a new default. Optional `enabledTools` / `disabledTools` are lists of non-empty raw tool names; absent or null is omitted (no filter) and an empty `enabledTools` is kept (no tools). Remote env fields remain accepted as before, regardless of client usage. Server parsing performs no connection or environment forwarding; those contracts belong to the MCP client.

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

Custom model entries accept `localPath` (v76): an absolute `.gguf` path added from disk, launched in place and never downloaded or deleted. An entry without it whose `huggingFaceUrl` is a `file:` URL naming an absolute `.gguf` takes the path back from that URL, because an older build rewriting the list drops `localPath` but keeps the URL. Whether the file still exists is checked at launch, not at parse time.

## Frontend, channel and integration settings

[TUI, channel and integration owners](frontend-integration.md) retain late normalization and separate resource ownership. TUI helpers capture onboarding/notify defaults once on entry, after evaluating their raw arguments; absent/null returns a fresh spread while present blocks retain validation. Root keeps the existing one-argument wrappers. Outer fallback expressions continue reading current defaults separately; raw notification downloads retain their early captured reference.

Discord's present owner list wins over the legacy scalar regardless of file version, including an explicit empty list; only the scalar is trimmed. Telegram numeric strings retain Number conversion. Swarm retains duplicate-id/token checks, sparse array behavior and owner-before-enabled validation. Missing owner/unit arrays ignore mutated default arrays. Mail and Composio nullable cached fields have no new default fallback, format validation or service operation. Download channel direct-null and whole-file default fallback remain distinct; Git parsing leaves execution/approval policy to tools.

## Writes and credentials

Preserve validation of provider/model pins and run mode. Writes that change user config must reset the cache as required by the existing API. Credential storage uses owner-only files and platform-specific ACL handling: `.env` and `config.json` are 0600 on POSIX, and on Windows both get a current-user-only ACL through [windows-acl.ts](../windows-acl.ts) (best effort; a failure leaves the inherited ACL and never fails the write). Missing optional credentials and required credentials have different behavior.

## Keys from a newer build

The desktop app and the terminal agent share one `config.json`, so an older build often saves a file a newer build wrote. The parse keeps unknown top-level blocks and drops unknown keys inside known blocks; `writeUserConfigFileSync` then reads the file on disk and puts back the keys it does not know inside fixed blocks, while known keys always come from the data being written, even when absent. Dictionaries (`webhooks`, `mcp.servers`, `llm.providers`), arrays and everything inside list entries are whole values from that data, so a removed server or provider stays removed. [config-shape.ts](../config-shape.ts) lists which blocks are fixed and which are dictionaries, plus known keys outside the defaults (`llm` and the retired `telemetry`, `agent.approvalRequired` and `discord.ownerUserId`); its test fails when a new block in the defaults is in neither list. The `llm` block is not descended, so nested keys there follow the parse.

## Sources and tests

- [Defaults/parser](../config-schema.ts), [precedence](../load-config.ts), [file writes](../config-file.ts), [unknown-key carry](../carry-unknown-config-keys.ts), [cache](../config-cache.ts), [owner-only files](../owner-only-file.ts).
- [Schema tests](../config-schema.test.ts), [LLM config](../llm-config.test.ts), [run-mode config](../llm-run-mode-config.test.ts).

## Execution and resource policies

[Concrete owners](execution-resource.md) separate full agent, outbound HTTP, project/shell/vision, skills, retention and tracing configuration from execution. Root retains version history and ordered assembly, including the early telemetry/tracing merge. Explicit default callbacks preserve conditional scalar reads, eager policy/retention arguments and captured ClawHub defaults. Read the linked guide before changing those mechanisms; moving settings does not grant broader tool access or change resource lifetime.
