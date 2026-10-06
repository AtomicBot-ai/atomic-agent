# Приёмка 05f: политики исполнения агента

Status: verified
Owner: repository maintainers

[План 05f](../plans/05f-agent-execution-config.md), [этап 05](../plans/05-config-tool-contracts.md). Выполнено 2026-10-06 после [05e](stage-05e-validation.md). Production agent владел schema/new owner, test agent — new suite и отдельной корректировкой двух config fixtures; read-only agent — differential/review/next-domain research; integrator — snapshots/proofs/boundaries/guides/debt reduction/приёмкой.

## Результат и сохранённые контракты

agent-execution-config.ts владеет AgentTaskConfig/ProviderWaitConfig, двумя fresh default factories и двумя parsers с explicit defaults. Schema 5463 → 5365 строк, owner 118. Четыре runtime/user nested type members используют structural-compatible owned types. Корень создаёт mutable defaults один раз на прежних позициях и передаёт текущие nested объекты при каждом parse call; missing/null возвращает тот же объект, present policy нормализуется в fresh object. Property mutation, nested/whole-agent replacement и прежние result references сохранены.

Default values/order, USER_CONFIG_VERSION=74, остальные defaults/assembly/migrations/env precedence, config/index, load-config и production consumers неизменны. Новых root public names нет. Private parsers стали intentional concrete-owner exports; owner импортирует только existing error и scalar primitives. Ни агентный цикл, ни ожидание/отмена провайдера, ни runtime overrides не переносились. Документационная поправка: task-parser JSDoc теперь у правильной функции; удалён unimplemented cross-field floor claim. Config по-прежнему допускает task ceiling ниже leg budget, runtime применяет свою политику позже.

## Доказательства

Snapshot /tmp/atomic-stage05f-before снят после verified 05e до production edits. Exact source proof допускает только 10 записанных root transformations и новый import: четыре structural aliases, две factories, два parser removals и два explicit-default calls. Четыре public nested shapes раскрыты и сравнены; normalization bodies совпадают после удаления локального root-default binding, factory return literals/value order/comments прежние. Это explicit-dependency refactor, не утверждение о byte-identical signatures/construction.

Read-only differential: 61 actual whole-root case и 5 reference/order scenarios, before/after JSON byte-identical. Включены exact fields/reasons/messages/error identity, полные defaults/outputs/runtime export names, absent/present alias distinction, property/nested/whole-agent mutation, raw/default getter timing и finally restore. Совпали также 369 scalar cases и 76 file/version cases с полными USER_CONFIG_DEFAULTS/ENV_DEFAULTS. Compiled smoke подтвердил current-default identity/fresh outputs/factories и прежнюю error class.

Parent source proof: 87 root public names, ровно 6 owner exports, 2378 прочих прежних TS/TSX файлов неизменны; inventory добавляет только owner и новый test. Единственное отдельное исключение — описанная ниже test fixture correction. Package/lock/compiler, .pr-review-56/EVIDENCE_ROUTER_MODEL.md и прочие protected hashes неизменны; test debt diff проверен отдельно.

18 новых tests закрывают default-reference gap, normalized fresh objects/null fallback/coercion/false, Date/class acceptance, отсутствие cross-field clamp, unconditional disabled-wait validation и exact errors на owner/root seam. Все мутации defaults восстановлены в finally.

## Отдельная корректировка двух тестовых фикстур

После extraction type gate отказал: две прежние TS2352 в providers-orchestrator.test.ts сохранили code/anchor/count, но alias names изменили текст ошибок, поэтому ledger правильно назвал их NEW/RESOLVED. Allowances не переписаны под новую ошибку. Вместо этого две incomplete full-config fixtures используют actual complete loadConfig baseline из isolated test state; прежние Gemini/OpenRouter llm literals и maxParallelToolCalls=8 сохранены. Два full-config casts и прежний agent cast удалены; production TUI не менялась.

Сначала raw/type checks подтвердили реальное устранение двух diagnostics, затем штатный reduce удалил ровно две TS2352. Остальные 854 fingerprints/counts и compiler options прежние; у оставшегося TS6133 в этом файле только line +5. Reduce также обновил inventory: два новых файла и девять уже принятых valid roots предыдущих 05a–05e, которые проверялись каждый раз, но ещё не были записаны в ledger inventory. Ни исключения типов, ни параметры checker не изменены. AST/fixture diff proof ограничивает correction helper/import и два object constructions; assertions тестов и остальные statements сохранены.

## Проверки

- Extraction schema: 219 tests passed. New suite: 18 passed.
- Focused config/CLI/agent-loop/stop-cause/segmentation/deadline/TUI args/outage: 32 suites, 737 tests passed.
- После fixture correction: providers/llm-panel/onboarding 75 suites, 886 tests passed.
- Full test:ci до и после fixture correction: 1046 suites, 12530 passed, 4 existing platform/GC skips, exit 0; final 41.19 s.
- lint/build и compiled smoke passed. Production не менялась после этих проверок.
- typecheck:tests: 2382 roots, 105 test TSX, 854 explicit diagnostics, no new errors. Reduce удалил только два исправленных cases; checker self-test 11 passed.
- imports:check: 1356 modules, 4877 edges, 0 runtime SCC/exceptions. Self-test 65 passed, четыре новых fixtures: static/type/dynamic composition backedges запрещены, inward scalar/error route разрешён. Negative fixture до policy закономерно отказал из-за отсутствия запрета.
- Docs self-test 11 passed; quarantine 0 active/2 released. Docs/budgets/links/metadata/diff passed; проверка повторена после приёмки и next-plan save.

Artifacts: /tmp/atomic-stage05f-{before,production-proof.mjs,production-extraction.json,proof.mjs,policy-capture.mjs,policy-before.json,policy-after.json,fixture-debt-proof.mjs,provider-fixture.diff,*-tests*.txt,*-types*.txt}. Captures/new tests используют synthetic inputs; fixture correction читает test-isolated config. No live providers/GPU/paid eval/manual platform QA; existing approved full-run HTTP/installation fixtures сохранены. Differential не исчерпывает все inputs; exact source/types proofs и существующие seams дополняют его. Улучшение агентной скорости/качества не измерялось. Весь этап 05 остаётся in-progress.
