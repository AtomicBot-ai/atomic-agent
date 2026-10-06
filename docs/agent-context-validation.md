# Stage 00 acceptance evidence

Status: current
Owner: repository maintainers

Recorded on 2026-10-06 for [plan 00](plans/00-agent-context.md). The stage is verified, including the authorized defaults-test routing exception below. No runtime speed/quality improvement is claimed.

## Documents and budgets

- Original root guide: 607105 bytes; current root AGENTS.md: 6310 bytes (8 KiB limit).
- Eighteen local instruction files, each below 4 KiB; nineteen repository instruction files in total. Maximum repository ancestor chain: 7689 bytes (24 KiB limit). User-global instructions are outside this repository budget.
- [Migration map](agent-context-migration.json) covers all 166 H2–H4 headings outside code fences, in original order, with current and mandatory-instruction owners. The archived guide hash is ae24a5d2df36bf92a846ddea2fbfa569291e17fa23ea8594af6c6a42dca752b3.
- Original files are checked against [archive checksums](archive/2026-10-06/originals.json). Legacy root names are compatibility pointers checked against [the move registry](document-moves.json).
- docs:check covers tracked Markdown plus the new src/scripts/docs guides, excludes fixture content and internal historical archive links, checks links to the archive, and performs no external requests. It passed. Its eleven temporary-fixture self-tests passed, including root/local/ancestor budget failures, missing targets, metadata and pointer failures.

## Behavior verification

`npm run lint` passed. The following existing Vitest files passed after the final defaults-test change: 11 files, 437 tests.

- src/prompt/build-prompt.test.ts
- src/prompt/conversation-cap-auto.test.ts
- src/prompt/default-tool-args-schemas.test.ts
- src/llm/profile-invariants.test.ts
- src/llm/grammar/build-grammar.test.ts
- src/agent/tool-resource-class.test.ts
- src/tools/tool-roles.test.ts
- src/config/config-schema.test.ts
- src/config/agents-md-defaults.test.ts
- src/runtime/turn-controller.test.ts
- src/runtime/steering-inbox.test.ts

The additional src/config/llama-url-env.test.ts passed its six tests. Full suite and test-typecheck debt were not declared passing; their cleanup is a later stage. git diff --check passed. TypeScript AST token comparison, excluding comment/JSDoc trivia, found identical non-comment tokens against HEAD in 51 of 52 changed TS files. The sole exception is the authorized defaults test: document paths and their names changed. No modules were moved; runtime API, config defaults, prompt literals and executable algorithms are unchanged. Existing operator review files were not touched.

## Fresh instruction discovery

Separate `codex --no-daemon -C <directory> debug prompt-input ...` invocations rendered the new model-visible input, independent of this ongoing chat. Path and content checks identified:

- Root working directory: /Users/aleksejkalina/.codex/AGENTS.md and repository AGENTS.md. No nested prompt instructions or archive content.
- src/prompt working directory: the same ancestors plus src/prompt/AGENTS.md. No old giant guide or archive content.

Two new ephemeral read-only `codex exec` sessions independently confirmed those headings, using only their supplied context. Their JSONL outputs contained only completed agent-message items; neither invoked tools. Raw input/output stayed in /tmp to avoid publishing unrelated user context.

The first root invocation initialized MCP servers from user configuration and logged startup errors. Automatic safety review rejected repeating that command. The subsequent subsystem invocation used --ignore-user-config, --disable plugins and --disable remote_plugin; it passed with no MCP startup errors. Both checks confirmed the root contract, and only the subsystem check received “Prompt assembly and cache contracts”. These observations justify explicit local reading from the root; they do not imply every editor discovers nested instructions the same way.

## Defaults-test routing exception: resolved

The existing src/config/agents-md-defaults.test.ts previously read the former root AGENTS.md and MEMORY_FABRIC_V2.md. Replacing them by routing documents initially failed two assertions: zero readable default claims versus the minimum 168, and an empty unresolved-key set versus its explicit three-key allowlist.

The new [user defaults](../src/config/docs/user-defaults.md) and [operational/helper defaults](../src/config/docs/operational-defaults.md) contain 210 documented values/parameters. A temporary copy of the existing test, redirected to these files, passed all three assertions without changing the coverage floor, resolver or allowlist. The temporary file was removed.

The operator authorized proceeding after the request for a narrow exception to the source-comments boundary. The real test now reads the two current guides and passes all three assertions. Coverage floors (168 Markdown claims, 23 schema claims), parsing, value comparison and the unresolved-key allowlist are unchanged. The relocation regression is resolved; it was not classified as pre-existing test debt.
