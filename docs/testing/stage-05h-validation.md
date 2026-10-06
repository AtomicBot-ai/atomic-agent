# Приёмка 05h: весь домен конфигурации памяти

Status: verified
Owner: repository maintainers

[План 05h](../plans/05h-memory-config.md), [этап 05](../plans/05-config-tool-contracts.md). Выполнено 2026-10-06 после [05g](stage-05g-validation.md). Production, tests и исследование следующего домена выполнялись параллельно с раздельными write sets; integrator владел общей схемой проверок, dependency policy, документацией и приёмкой.

## Результат

Все 15 блоков memory configuration перенесены вместе в src/config/memory/: memory-types.ts владеет двумя прежними ordered user/runtime shapes и gate-mode union; memory-defaults.ts — fresh mutable construction; memory-parser.ts — ранней подготовкой raw references, поздней normalization и прежними domain helpers. Root config-schema.ts: 5124 → 3885 строк; новые owners: 596/158/594 строки. Runtime memory algorithms, providers, prompt и consumers не менялись.

19 ранних raw reads сохраняют порядок и удерживаемые references; validation остаётся в прежнем позднем месте. Каждое из 78 fallback expressions отдельно читает current defaults. Сохранены short-circuiting, семь безусловных default-argument reads для v22 feature migration и три повторных чтения defaults для shared v65 timeout migration. Default factories не кешируют и не замораживают объекты. Root сохраняет прежнюю публичную поверхность; новые construction/preparation APIs внутренние.

Исправлены только проверенные комментарии: private v22 constant описывает семь feature flags, без ложной embedding-model migration; user links/evolution отражают нынешний enabled default; относительная ссылка на retrieval указывает из нового каталога. Ошибочная запись плана о profile.maxEntries=0 исправлена: shipped validator по-прежнему требует positive integer. Defaults/version/accepted inputs не изменены.

## Доказательства

Fresh snapshot /tmp/atomic-stage05h-before снят после verified 05g до production writes. Source proof сохраняет весь остальной root text после записанных transformations, два раскрытых ordered types, gate union/public parser/private v22 helper, default literal/order/nesting/comments и последовательность ранних reads. Late normalization token-equivalent после 78 recorded default-thunk/inputVersion substitutions. Четыре точные comment corrections перечислены отдельно; whole-parser byte identity не заявляется.

Actual old/new differential: 404 output/error/version cases и 11 reference/getter scenarios byte-identical. Включены supported/future versions, boundaries 21/22 и 64/65, errors/class identity/field precedence, held raw references, nested/whole-default replacement, unconditional feature defaults и repeated timeout reads. Дополнительно совпали 369 scalar cases, 76 version/file outputs, полные USER_CONFIG_DEFAULTS/ENV_DEFAULTS. Каждая mutation восстановлена в finally.

Parent proof: все 87 root public names сохранены; types/defaults/parser имеют 3/1/4 намеренных owner exports. 2382 прочих прежних TS/TSX files byte-identical; ровно четыре новых source/test files. Единственное отдельно разрешённое existing test изменение — inventory источников JSDoc. config/index/load-config, package/lock/compiler/test-debt, protected .pr-review-56/EVIDENCE_ROUTER_MODEL.md hashes неизменны; dependencies/allowances не добавлены.

40 новых meaningful tests проверяют factory/nested freshness, validation identity, early/late phase ordering, v22/v65 seams, getter short-circuit/repeated reads, within-call defaults replacement, permissive inputs/zero/weights/exemplars и семь cross-domain error pairs. Scalar tests не переписаны.

## Сверка документации с defaults

Первый integrated прогон выявил source-location зависимость: agents-md-defaults.test.ts читал JSDoc только root и увидел один claim вместо minimum 23. Inventory расширен до composing schema и agent-execution/web/memory types owners; collector получает path/label. Все regexes/resolvers/judge/allowlists, floors 23/168 и три existing assertions сохранены, что отдельно проверено AST proof. Сейчас сверяются 23 JSDoc claims и 207 Markdown claims без расхождений.

Negative check выполнялся на временных копиях вне repository: замена enabled на disabled в memory.links JSDoc вызвала ожидаемый exit 1 с точным mismatch «documented false, ships true». Настоящие repository defaults/types при этой проверке не менялись. Покрытие не ослаблено ради успешного прогона.

## Проверки и ограничения

- Existing schema: 219 passed; new memory suite: 40 passed. Focused config/memory/CLI/agent/prompt: 84 suites, 1387 tests passed.
- Full test:ci final: 1048 suites, 12604 passed, 4 existing skips, exit 0, 35.47 s. Предыдущий прогон после исправления JSDoc inventory упал на существующем timing-sensitive download reconnect test: ожидал пять запросов, получил два. Download source/test bytes не менялись; отдельный suite прошёл 17/17, затем полный повтор без конкурирующих проверок прошёл. Этот сбой не скрыт и не исправлен ослаблением теста; timing sensitivity остаётся ограничением существующего suite.
- lint/build passed. Compiled smoke подтвердил public helper identity, defaults/nested freshness, v22/v65 boundaries и validation error class.
- typecheck:tests: 2388 roots, 105 test TSX, прежние 854 explicit debt diagnostics, no new errors. Ledger и compiler options unchanged.
- imports:check: 1360 modules, 4888 local edges, 0 runtime cycles/exceptions. Self-test: 81 fixtures passed, включая девять новых static/type/dynamic inward/backedge cases. Policy проверяет direct source dependencies, не bare packages/transitive loading.
- Docs self-test: 11 passed; docs:check budgets/links/metadata/pointers, quarantine 0 active/2 released и git diff whitespace checks passed после сохранения приёмки/следующего плана.

Artifacts: /tmp/atomic-stage05h-{before,production-proof.mjs,production-extraction.json,proof.mjs,memory-capture.mjs,memory-before.json,memory-after.json,doc-harness-proof.mjs,doc-negative.txt,*-tests*.txt,*-types*.txt}. Captures используют synthetic inputs без live providers/user credentials. Full runner использует существующие approved HTTP/installation fixtures. Paid/GPU/manual platform eval и измерение качества/скорости агента не выполнялись; differential не исчерпывает все inputs и дополняется exact source proofs/existing seams.

05h verified. Весь 05 ещё in-progress; следующий согласованный domain описан в [05i: localModels configuration](../plans/05i-local-models-config.md), implementation ещё не начата.
