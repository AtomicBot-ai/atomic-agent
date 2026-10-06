# Приёмка 05l: core filesystem contracts и общий gate

Status: current
Owner: repository maintainers

[План 05l](../plans/05l-filesystem-contracts.md). Проверено 2026-10-06 после 05k. Это последний блок этапа 05; новые alphabet slices не требуются. Конечная приёмка всего этапа — [здесь](stage-05-validation.md).

## Что изменено и почему

Двенадцать новых import-free fs-*-contract.ts дополняют существующий hash: 13 core operations имеют одного владельца name/description/readonly/descriptor/argsJsonSchema/resourceClass. Исполнение, prompt/schema и taxonomy берут явные проекции на прежних позициях; static registration order не генерируется. Это устраняет независимое редактирование общих значений в четырёх местах без переписывания dispatch.

Pure read/list/diff/edit и initial write/trash/restore validation перенесены точно; list helper и бюджет используются из единственного owner. Diff получает существующий node:path.basename callback на прежних позициях. Glob/grep/locate_project сохраняют contextual path/discovery parsers; watch сохраняет stat-before-options, patch — file-read-before-late-options. Domain/security/approval/read-scope/restore algorithms и policy mappings unchanged. Archive/read_document вне canonical family. Исправлен только один перенесённый неточный DiffArgs комментарий: одновременные path/text inputs parser отвергает, а не игнорирует.

Новые read-contract tests: 8; operation-contract tests: 26. Проверены defaults/coercion/ошибки/getter order и effect boundaries. Global tests: 8; runtime composition: 3. RecordingRegistry наблюдает real builders до Map.set; private schema map инвентаризируется test-only TypeScript AST, unsupported syntax fail с source position. Проверяются union/missing/orphan/duplicate facets, 13 canonical projections, roles/discovery/loaded union/native wire/grammar, conditional registration, отдельная read-scope decoration и actual MCP manager/client start/restart/shutdown с transport spies. Негативные мутации независимы; shipped objects не изменяются.

## Честная граница глобальной проверки

Каталог содержит 88 записей для 85 имён. Старые Git push/commit/checkout duplicates сохранены с точными позициями и полными ordered SHA256 fingerprints, owner/reason. Gate запрещает новые, изменённые, исчезнувшие и третьи копии; static registration duplicates не разрешены. First native wire и last discovery используют разные копии, поэтому удаление изменило бы поведение. [Отдельное предложение](../proposals/tool-catalog-deduplication.md) фиксирует устранение этого долга.

Для core 13 gate доказывает canonical metadata/schema/class equality; для остальных — наличие/формат и actual taxonomy lookup, а не семантическое равенство без canonical oracle. Независимый before/after capture защищает от ошибочного совместного изменения всех consumers. Reply/finish фактически присутствуют в static catalog; исходное предположение плана исправлено. Named terminal exception касается wire overrides/role bypass. Feature registration и descriptor availability не тождественны; runtime tests проверяют disabled/enabled и tasks.enabled=false при agentTools=true. Dynamic MCP schemas и replacement не подменяются static duplicate exemption.

Обе global/runtime suites проходят на current и disposable old graph: 11/11. В старую копию добавлены только новые тесты и canonical leaves; старые registrars/catalog/schema/classifier сохранены. Это дополняет сравнение outputs, не означает выполнение нового execution в старом graph.

## Сохранение поведения и границ

Immutable /tmp/atomic-stage05l-before создан до записей. A proof: 4 import-free leaves, 17 точных переносов, 26295 неизменных execution bytes; B proof: 8 owners, 48 metadata facets, 3 exact inline blocks, 5 untouched contextual parsers. Parent воспроизводит 36 recorded shared projections в трёх composition files. Ровно 15 существующих production files изменены; 12 новых contracts и 4 новых test files. Остальные 2405 существующих non-Markdown source files byte-identical, включая config/runtime/LLM/registry/roles/read-target/security owners и все прежние tests. Hash contract и hash test unchanged.

54 output artifacts (53 представления плюс manifest), включая 18 stable prefixes: 3 роли × 2 транспорта × 3 профиля, full catalog/schema/class/order/OS metadata/exports, approval/read targets, loaded schemas, plain/strict wire и widened args — byte-identical. Whole-stage config comparison: 1602 cases, 26 reference/getter scenarios, USER_CONFIG_DEFAULTS/ENV_DEFAULTS/version74/error fields/result order/runtime exports identical. TypeScript checker: 87 public symbols bidirectionally assignable, recursively expanded ordered UserConfigFile/AtomicAgentConfig/ENV_DEFAULTS shapes/optional/readonly exact, root diagnostics0. Это конечная матрица whole05, а не заявление исчерпывающего перебора inputs.

24812 protected hashes unchanged; package/lock/compiler/CI/grammars/debt unchanged относительно 05l baseline. Scripts изменены только в existing imports checker/self-test. Политика запрещает любые static/type/dynamic/bare/external imports из FS contract. 53 new negative/positive fixtures сначала обнаружили отсутствие запрета; итог 188 passed. Graph: 1386 modules, 4987 local edges, 0 cycles/exceptions.

## Фактические прогоны и исправления

- Full test:ci: 1059 suites, 12792 passed, 4 existing skips, exit0, 56.00s. Карантин: 0 active, 2 released; self-test8 passed.
- lint/build passed; starter skills copied. Test type gate: 2425 roots, 105 test TSX, 848 explicit debt diagnostics, no new errors. Raw tsc остаётся красным из-за этого долга, который не скрывается под PASS.
- Первая type-проверка обнаружила новый TS2322 throwing restore getter в fixture. Исправлена genuine return annotation FileRestoreStore | undefined, без casts/allowances; operation26 и конечный gate проходят.
- Sandbox blocked домашнюю retarget fixture и native watcher (EPERM/EMFILE). Polling5 использовался только как диагностика. Повтор с разрешениями для прежних native fixtures: 11 passed; полный runner с этими разрешениями passed. Polling не считается native acceptance.
- Docs self-test11 passed; final docs links/metadata/budgets и git diff --check проверяются после сохранения всей evidence/next plan. Никаких instruction edits в 05l; fresh session proof из stage00 не заменяется текущей сессией.

## Навигация по фактическим guides

Прочитаны текущие root routes и локальные guides после обновления: prompt change → prompt AGENTS/README/assembly + tools при catalog interface, build-prompt/profile/grammar tests; add tool → tools AGENTS/contracts + fs contract guide + global/runtime/role/read-scope tests; migration change → config AGENTS/README/compatibility + concrete domain parser и schema/load/version tests; MCP UI → tui/mcp README + TUI/MCP instructions/client + panel/orchestrator/config/HTTP tests; download change → local-llm instructions/downloads README/download contract + downloads/CLI/self-invocation/UI seams. Это navigation audit, не утверждение новой автоматической загрузки AGENTS.

Артефакты /tmp/atomic-stage05l-{before,read-transforms.json,read-proof.mjs,operation-extraction.json,operation-proof.mjs,shared-transforms.json,parent-proof.py,parent-proof.json,before-outputs,final-outputs,pre05-config-values.json,final-config-values.json,type-surface.mjs,type-surface.json,*txt}. Live models/GPU/provider eval, native trash на всех платформах, throughput и качество работы агента не измерялись. Commit/push/release не выполнялись; прежние изменения рабочей ветки сохранены.

Final documentation check: active links/metadata/pointers/archive coverage и instruction budgets проходят; 19 instruction files, maximum chain8093/24576 bytes. Docs self-test11 и git diff --check passed. Этап05 и05l verified; следующий [план06](../plans/06-runtime-composition.md) specified, без implementation.
