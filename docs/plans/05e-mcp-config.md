# Срез 05e: общие значения и конфигурация MCP-серверов

Status: verified
Owner: repository maintainers

[Этап 05](05-config-tool-contracts.md). Начат после [приёмки 05d](../testing/stage-05d-validation.md). База: 856 diagnostics, 0 SCC/exceptions; full suite 1044/12498/4 existing skips.

[Приёмка 05e](../testing/stage-05e-validation.md) выполнена; следующий [05f execution policy](05f-agent-execution-config.md) specified, implementation не начата.

## Цель и границы

Выделить весь parser MCP transports/names/headers/env/trust вместе с двумя используемыми общими validators; совместный перенос исключает backedge нового MCP owner в composing schema. Config values не выполняют network/SSRF policy, MCP config не запускает transports и не материализует default trust. Neutral MCP types остаются в src/mcp/mcp-types.ts; runtime manager/approval/dynamic catalog принадлежат прежним owners.

## Write sets

Production agent: новый config-values.ts (parseStringArrayOrNull, parseUrl) с existing error/primitive dependencies; новый mcp-server-config.ts (parseMcpServers, private parseMcpTrustLevel/parseMcpEnv/parseMcpHeaders/parseMcpTransport, HTTP_HEADER_NAME_RE) с values/primitives/error и neutral mcp-types constants/types; config-schema.ts для совместимых трёх function exports/imports и удаления unused neutral bindings. Все семь function bodies/signatures и regex initializer/comments сохраняются. Schema сохраняет type-only McpServerConfig import и прежний direct MCP types re-export. Default mcp={servers:[]} и parseUserConfigFile assembly не менять.

Test agent: новый mcp-server-config.test.ts для meaningful missing seams, при необходимости один отдельный shared-values suite; не переписывать existing command/import/TUI/HTTP tests. Integrator: snapshots/proofs/guide/scripts/debt/plan/evidence/checks. config/index, neutral mcp-types и existing consumers byte-identical. Private helpers/regex не расширяют root public API. No version bump/default/global-state/dependency/algorithm changes.

## Совместимость

Shared list сохраняет null/undefined→null, пустой/дублирующий/whitespace list без dedup и exact indexed errors. URL лишь проверяет форму и возвращает исходные bytes, сохраняя whitespace/non-HTTP scheme acceptance. Env defaults/clamps не объединять с этими functions.

MCP: list absence/null→fresh []; order/duplicate index сохраняются. Existing name regex/32 ceiling остаются, в том числе отказ односимвольных names. enabled defaults только для undefined; null отвергается. Trust/description omission, empty-map versus omission, env keys versus RFC header tokens и empty string values сохраняются. Stdio args:null omitted, args:[] retained; command/cwd whitespace допускается, empty string отвергается. HTTP/SSE URL/header semantics прежние; env на remote transport не удалять, даже если клиент его не использует. No resource-class/approval/env-forwarding changes.

## Приёмка

После verified 05d до code edits свежий src/scripts/docs/protected/debt/package/default/version/export snapshot и 80-case synthetic actual capture, включая parseAddServerJson wrapper errors. Не использовать research-time output как acceptance baseline. Exact seven bodies/constant/type re-export и unmoved schema text; прочие source/default/protected/prompt/catalog bytes неизменны. Root/owner function identity и direct error class/fields/messages, mixed transport root assembly, independent null/empty/whitespace/duplicate/name/error scenarios. Один существующий command test с name=x отказывает раньше transport; новые tests используют valid names и pin exact nested field, исключая такой ложноположительный результат.

Existing config/load/file/CLI/MCP commands, import/claude-code/map-mcp.test.ts, import/oh-my-pi/map-mcp.test.ts, TUI MCP suites, HTTP route-mcp и MCP manager/resource-class seams. Lint, full type gate без нового долга, imports 0 SCC/exceptions, docs/diff/build/quarantine и full test:ci. Для изменённой import policy сначала negative failure и positive fixtures; новые leaf owners не импортируют schema/index, values не зависит от MCP owner. Записать фактические проверки и ограничения; лишь затем verified.

Следующий defaults-dependent domain требует явного интерфейса типов/default inputs и отдельной specification после этого результата. Не начинать runtime/agent-loop и не отмечать весь 05 verified по одному MCP срезу.
