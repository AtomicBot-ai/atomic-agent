# Приёмка 05e: общие значения и MCP server config

Status: verified
Owner: repository maintainers

[План 05e](../plans/05e-mcp-config.md), [этап 05](../plans/05-config-tool-contracts.md). Выполнено 2026-10-06 после [05d](stage-05d-validation.md). Production agent владел schema/двумя owners, test agent — новым joint seam suite, read-only agent — следующим default-dependent slice; integrator владел capture/proofs/boundaries/guides/checks.

## Результат и совместимость

config-values.ts содержит parseUrl/parseStringArrayOrNull; mcp-server-config.ts — parseMcpServers, четыре private helpers и HTTP_HEADER_NAME_RE. Семь function declarations/bodies/ownedcomments и regex сохранены. Types/constants остаются в neutral mcp-types; root сохраняет прежний direct type re-export шести names и три function compatibility exports. Root local import теперь только type McpServerConfig. Schema 5707 → 5463 строк, values 40, MCP owner 216.

config/index, commands/import/TUI/HTTP consumers, default mcp block, whole-file assembly, USER_CONFIG_VERSION=74, migrations/env precedence и protected/package/compiler/ledger не менялись. Values выполняют parse-only validation; MCP owner не запускает server/client и не меняет trust classification/environment forwarding. URL сохраняет bytes/non-HTTP acceptance; args:null omission и args:[] retention, enabled:null refusal, namespaces/headers/env/optional defaults прежние.

## Доказательства

Acceptance snapshot /tmp/atomic-stage05e-before снят после verified 05d до edits; research-time baseline отдельно. Actual 80 synthetic cases (38 accepted/42 rejected) по shared values/MCP/wrapper errors совпали byte-for-byte. Также совпали 369 scalar cases, 74 webhook/direct-root cases, 76 file/version cases и полные defaults. Ошибки включают class identity, fields/reasons/messages; no golden refresh.

Exact production proof сравнил семь bodies/regex/comments, записанные imports/exports и весь остальной schema text/statements. Parent proof — те же declarations, 87 public names, точные leaf exports и neutral import, 2376 прочих прежних TS/TSX files и inventory ровно трёх новых source/test files. Protected .pr-review-56/EVIDENCE_ROUTER_MODEL.md/package/lock/compiler/test-debt hashes сохранены. Compiled smoke подтвердил identity root/owners, URL bytes, normalized stdio shape и прежний error class/field.

14 новых joint tests закрывают missing seams: три root/owner function refs, mixed stdio/HTTP/SSE root assembly, omitted-null versus empty retained, whitespace/duplicates, env/RFC header key distinction, URL form/bytes и exact indexed parser/wrapper errors. Transport-error fixtures используют valid namespace, чтобы name refusal не маскировал проверяемое поле. Existing tests не редактировались, casts/allowances/dependencies не добавлялись.

## Проверки

- Focused config/CLI/import/TUI/MCP manager/resource-class: 31 suites, 642 tests passed. New suite 14 passed; extraction schema 219 passed.
- Full test:ci: 1045 suites, 12512 passed, 4 existing platform/GC skips; exit 0, 36.14 s. Approved loopback/home fixtures preserved; quarantine unchanged.
- lint/build и compiled API/shape/error smoke passed.
- typecheck:tests: 2380 roots, 105 test TSX, прежние 856 diagnostics, no new errors. No capture/reduce/rebase/options changes.
- imports:check: 1355 modules, 4874 edges, 0 runtime SCC, 0 exceptions. New owners change graph ownership intentionally; no claim entire edge set is unchanged. Self-test 61: 8 new fixtures, negative initial failures before policy; values/MCP root backedges and values→MCP config запрещены; concrete inward/type owner links разрешены.
- Docs self-test 11, docs:check/budgets/links/metadata и diff passed after acceptance/next-plan save; quarantine check 0 active/2 released. Type/quarantine checker code untouched, previous self-tests not repeated.

Artifacts: /tmp/atomic-stage05e-{before,proof.mjs,mcp-proof.mjs,mcp-extraction.json,*-values.json,*-tests.txt}; capture /tmp/atomic-stage05d-mcp-capture.mjs. No live MCP servers/processes/network operations/user credentials/config writes in captures/new tests; existing approved HTTP fixtures covered by full runner. No paid/GPU/model eval/manual platform QA; no measured agent-quality claim. Differential cases не исчерпывают возможные inputs; exact declarations и existing seams дополняют их.

05e verified; [05f](../plans/05f-agent-execution-config.md) specified. Весь 05 ещё in-progress: default-dependent domains/migrations и распространение tool contracts не завершены.
