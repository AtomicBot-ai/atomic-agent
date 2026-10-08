# Configuration and compatibility

Status: current
Owner: src/config/

This area owns configuration and compatibility. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [config-schema.ts](config-schema.ts)
- [config-primitives.ts](config-primitives.ts)
- [config-values.ts](config-values.ts)
- [agent-execution-config.ts](agent-execution-config.ts)
- [full agent policy](agent/README.md)
- [http-config.ts](http-config.ts)
- [tool-config.ts](tool-config.ts)
- [skills-config.ts](skills-config.ts)
- [session-retention-config.ts](session-retention-config.ts)
- [tracing-config.ts](tracing-config.ts)
- [web-config.ts](web-config.ts)
- [memory configuration](memory/README.md)
- [local model configuration](local-models/README.md)
- [tui-config.ts](tui-config.ts)
- [channel-config.ts](channel-config.ts)
- [integration-config.ts](integration-config.ts)
- [session-rail-config.ts](session-rail-config.ts)
- [webhook-config.ts](webhook-config.ts)
- [load-config.ts](load-config.ts)
- [config-file.ts](config-file.ts)
- [config-cache.ts](config-cache.ts)
- [llm-config.ts](llm-config.ts)
- [llm-provider-commands.ts](llm-provider-commands.ts)
- [mcp-server-commands.ts](mcp-server-commands.ts)
- [mcp-server-config.ts](mcp-server-config.ts)

## Ownership and dependencies

config-schema owns whole-file assembly, version acceptance and compatible public exports; domain owners supply field types, defaults and normalization. load-config owns environment precedence. llm-config and llm-run-mode-config own the separate provider/model and fusion surfaces. File/credential helpers own persistence and permissions; the cache makes config changes visible to callers. Provider commands own persistence shared by channels and TUI; MCP server commands own add/remove/enable persistence shared by HTTP and TUI; they preserve validation, credential permissions and cache reset. Live runtime switching belongs to callers. Consumers depend on validated values rather than reconstructing defaults.

config-primitives owns scalar coercion and validation and imports only the existing ConfigValidationError owner. config-schema deliberately keeps its nine previous scalar parser exports for compatibility; coercers are available only from their concrete owner. The primitive module must not import the composing schema or config/index. New internal scalar consumers can use this owner; defaults, domain-specific validation and version-dependent migration remain in their existing modules.

session-rail-config owns the stored session order/pinning type and parser. It depends only on the existing validation error, without loading defaults or sessions. config-schema keeps compatible type/parser exports and assembles the whole file. Filtering stale ids, persistence and display order belong to [the TUI rail](../tui/session-rail/README.md).

webhook-config owns webhook map normalization, session-mode requirements and schedule shapes. It uses scalar/error owners and the TaskSchedule type without loading task execution or HTTP. config-schema keeps compatible type/parser exports; the [HTTP webhook route](../http/route-webhooks.ts) materializes tasks and [task scheduling](../tasks/task-schedule.ts) owns canonical execution-time validation.

config-values owns shared URL, trimmed nullable-string and nullable-string-list validation. mcp-server-config owns server name/enabled/trust and stdio/HTTP/SSE transport normalization, using values/primitives/error and [neutral MCP types](../mcp/mcp-types.ts). config-schema keeps compatible parser exports and whole-file/default assembly; MCP commands and import consumers continue using that API. Parsing performs no connection/process/file operation and does not derive resource trust defaults; the manager/client retain execution and lifetime ownership.

agent-execution-config owns task ceilings/continuation and provider-outage waiting types, default factories and parsing. The composing schema creates its exported mutable defaults once and passes the current nested objects at each parse call. The domain imports only scalar/error owners; it does not read global config or execute the agent loop. Missing blocks retain the default object reference; present blocks normalize into fresh objects.

web-config owns search/fetch types, default factories and validation. Search preparation validates the provider at the existing early point; remaining search fields and fetch are normalized later during whole-config assembly. Explicit default lookups retain mutable-default behavior and validation order. The module depends only on scalar/error owners; search providers, caches, page retrieval and transport guards remain tool operations. Root preserves the existing public types/parser exports.

memory/ owns the full stored memory policy with separate types/default/parser modules. Root schema keeps whole-file assembly and public gate-mode exports; the domain retains early raw-reference preparation, late validation and v22/v65 compatibility through explicit default lookups. Durable stores, retrieval/formation and provider lifetimes remain memory/runtime responsibilities.

local-models/ owns separate runtime/user types, fresh default construction and two-phase parsing. Root preserves compatible types/functions and composes LLM providers between early managed/embedding/download preparation and late completion/template/thinking validation. Defaults are explicit per-expression lookups; version helpers retain conditional reads. Concrete catalog/backend/constants remain dependencies, while process, download and environment ownership stays outside config.

tui-config owns appearance/input/onboarding/terminal notification settings; channel-config owns Telegram/Discord/swarm; integration-config owns download notifications/mail/Git/Composio settings. All use explicit defaults and retain their old late positions. Root keeps the two one-argument default-dependent TUI parser wrappers; pure helpers/types are compatible re-exports. Read [their shared guide](docs/frontend-integration.md) for captured-default, retained-reference and migration seams. Connection, delivery, secrets and UI behavior remain with runtime/frontend owners.

agent/ owns the full agent runtime/user policy around the existing execution leaf. http-config owns outbound HTTP; tool-config supplies separate projects/shell/vision slots; skills-config, session-retention-config and tracing-config own their resource settings. Root keeps early references/legacy trace preparation and original late order; its one-argument ClawHub wrapper passes captured defaults explicitly. Read [execution/resource configuration](docs/execution-resource.md) for eager reads, migration and lifetime boundaries.

## Task-specific reading

Read [compatibility](docs/compatibility.md) for schema/default/migration changes; [user defaults](docs/user-defaults.md) and [operational defaults](docs/operational-defaults.md) contain checked values. Read ../approval/AGENTS.md for approval settings.

[Model behavior mode](../llm/docs/model-mode.md) documents provider defaults, per-model overrides and the v75 migration of existing cloud connections without a policy. [model-mode-commands.ts](model-mode-commands.ts) owns manual changes and cache invalidation for this setting. [Provider commands](llm-provider-commands.ts) assign and return an initial saved default for new connections, sharing classification with the schema migration through [model-mode.ts](model-mode.ts). After migration, updates preserve omitted policy fields without reclassifying entries.

## Validation

`npx vitest run src/config`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).
