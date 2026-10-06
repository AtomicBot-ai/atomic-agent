# Приёмка 05k: политики выполнения и ресурсов

Status: verified
Owner: repository maintainers

[План 05k](../plans/05k-execution-resource-config.md), [этап 05](../plans/05-config-tool-contracts.md). Выполнено 2026-10-06 после [05j](stage-05j-validation.md). Три agents параллельно владели непересекающимися новыми source/test files; integrator сохранял root assembly, снимок, сравнение поведения, import gates и общую приёмку.

## Результат и граница

Root config-schema.ts сократился с 2471 до 1521 строки. Восемь новых production files составляют завершённую группу:

- agent/agent-types.ts (266 строк), agent-defaults.ts (23), agent-parser.ts (166): полный runtime/user policy вокруг прежнего agent-execution-config.
- http-config.ts (104) и tool-config.ts (167): outbound HTTP и отдельные projects/shell/vision slots.
- skills-config.ts (218), session-retention-config.ts (102), tracing-config.ts (58): настройки соответствующих ресурсов.

Root оставляет составление whole-file результата, версию/историю, ENV/bootstrap/unknown keys, небольшие log/analytics blocks и три compatibility wrappers. Дополнительного переноса ради нулевого размера root не требуется. Early raw references и legacy telemetry/current tracing merge буквально сохранены в root. Каждый поздний parser вызывается в прежнем месте.

Public API сохраняет 87 имён. ReadScope/READ_SCOPES, pure validators и constants экспортируются из прежнего root без копий. ApprovalLevel остаётся direct neutral type export. ClawHub one-argument wrapper сохраняет прежнюю return signature и передаёт callback; owner захватывает nested defaults один раз при входе. Existing TUI wrappers unchanged. Default factories дают свежие mutable literals; нет глобального defaults hook/cache/freeze.

Сохранены eager чтение двух approval arguments, presence-driven migration на любой version, eager policy default arguments и absent policy references; HTTP pre-v25 skip default lookup; retention eager fallback при explicit null; per-expression defaults, ClawHub capture/absence spread; retained shell/retention inputs, ранний trace spread и old late error precedence. Runtime/tool/security/installation/deletion/inference/trace algorithms не менялись. User/runtime type differences и persisted JSON остаются прежними.

Misplaced bounded-positive validator JSDoc перенесён из root непосредственно к своему существующему helper в config-primitives; весь остальной primitive file и function bodies прежние. Восемь новых domain owners не зависят от root или execution. Локальный [guide](../../src/config/docs/execution-resource.md) объясняет ответственность, механизмы и проверки; [agent guide](../../src/config/agent/README.md) маршрутизирует новый каталог без пустого AGENTS/barrel.

## Доказательства совместимости

Fresh /tmp/atomic-stage05k-before создан до writes: src/scripts/docs/CI/package/compiler; hash inventory содержит 27442 files. Isolated actual old graph запускается через tsx отдельно от current graph. Whole/direct/version матрица содержит 1602 cases, 26 reference/getter scenarios. Полные USER_CONFIG_DEFAULTS/ENV_DEFAULTS, версии/unknown fields, error identity/fields/messages, result order и runtime exports byte-identical. Mutations восстановлены в finally.

Включены 24/25 HTTP и presence-only approval migration, обе eager raw approval reads, eager task/provider-wait defaults, retention null fallback reads, внутри-вызова замены outer/nested defaults, ClawHub capture/spread/raw-before-default, retained inputs, legacy/current trace spread/getter order, arrays/zero/disabled validation и cross-domain error pairs. Матрица также повторяет ранее принятые frontend/integration cases. Она не исчерпывает произвольный input и дополняется source proofs и existing seam tests.

Root source proof воспроизводит ровно 54 recorded transformations и сравнивает остальные байты. Leaf proofs раскрывают все ordered runtime/user types/comments, literals и helper bodies; late expressions отличаются лишь записанными AST identifier/default callback substitutions, error strings сверяются отдельно. Parent подтверждает exact early raw/trace preparation и ClawHub wrapper signature, остальные 2394 прежних TS/TSX files byte-identical, ровно восемь новых production и три test files. Existing agent-execution/config-index/load/cache/file/consumers unchanged. 24812 protected hashes, package/lock/compiler/CI и scripts вне двух import-checker files unchanged.

## Проверки типов и обнаруженные проблемы

Перенос skills shape сохранил пять существовавших TS2739 ошибок CLI writer fixtures, но имя UserSkillsConfig изменило diagnostic wording, поэтому debt gate их отверг. Исправлены ровно пять fixtures в cli/skill.test.ts: перед прежними overrides добавлены полные skills defaults, как требует writer API. Assertions и намеренно неполный invalid-parser fixture unchanged; 18 CLI tests passed. Нет casts/новых allowances/ослабления compiler. Reduce удалил только эти две diagnostic groups (4+1): 853 → 848. Ledger root inventory обновлён до actual 2409; остальные diagnostic entries exact.

Первичные lint/build обнаружили unused internal imports после переноса. Удалены только unused bindings, public re-exports сохранены. Retention owner лишний error import удалён до final acceptance. Один trace differential fixture сперва пытался присвоить значение getter-only property и проверял TypeError вместо задуманного результата. Fixture исправлен через defineProperty; оба immutable-old/current capture повторены, trace result/getter-order совпадают. Все final checks выполнены после исправлений; ранние незавершённые прогоны не считаются PASS. Integrator type-shape replacement assertion также остановилась до записи при двух одинаковых shapes; повторный перенос адресует каждый owning interface целиком, а не неоднозначный текст.

## Автоматические границы и документация

Добавлены exact concrete inward import allowlists для восьми files; neutral agent types нельзя runtime-load. Static/type/literal-dynamic edges проверяются одинаково, execution/root/peer dependencies запрещены, exceptions не добавлены. 26 новых self-test fixtures сначала выявили отсутствие policy, затем все прошли вместе с прежними 109: всего 135. Runtime graph: 1374 modules, 4939 local edges, 0 cycles/exceptions. Bare packages/transitive loading вне scope этого gate.

JSDoc inventory дополнен шестью type-owner sources; остальные statements/regex/judge/floors/allowlists/assertions exact. Actual coverage: 23 schema claims и 207 Markdown claims, без mismatch; новые источники пока не добавляют распознаваемых claims. Шесть временных копий с ложными claims agent.maxSteps/http.approvalMode/shell.maxJobs/clawhub.browseLimit/retention.maxAgeDays/trace.maxBytesPerSession вызвали ровно шесть ожидаемых JSDoc failures, двенадцать остальных assertions passed. Repository sources/defaults не мутировались.

## Итоговые команды

- New suites: agent 8 + HTTP/tool 26 + resource 18 = 52 passed; existing schema 219 passed.
- Focused config/approval/read-scope/shell/projects/HTTP/vision/skills/tracing/retention/prompt seams: 78 suites, 1274 passed. CLI fixture suite: 18 passed.
- Full test:ci: 1055 suites, 12747 passed, 4 existing skips, exit 0, 37.12 s.
- lint/build passed. Compiled smoke: five pure function identities + READ_SCOPES/constant identity, one-argument ClawHub wrapper, absent policy reference/freshness, HTTP migration и retention null passed.
- typecheck:tests: 2409 roots, 105 test TSX, 848 explicit existing debt diagnostics, no new errors; reduce только пять исправленных fixtures.
- imports:check/self-test passed; docs self-test 11 passed; quarantine 0 active/2 released.
- docs:check: 228 active files, 19 instruction files; maximum chain 8093/24576 bytes; links/metadata/pointers/archive coverage passed после save acceptance/next plan. git diff --check passed.

Artifacts: /tmp/atomic-stage05k-{before,capture.mjs,before-values.json,after-values.json,root-transforms.json,proof.mjs,agent-*,tool-*,resource-*,cli-fixtures.json,*tests.txt,*types*.txt,doc-negative.txt}. Проверки используют synthetic data и existing изолированные HTTP/installation fixtures. Live model/provider/GPU/platform eval и измерение качества работы агента не выполнялись. Предыдущие source changes рабочей ветки сохранены; commit/push/release не выполнялись.

05k verified. Доменная организация config завершена в согласованных границах; весь этап 05 ещё in-progress. Следующий [05l](../plans/05l-filesystem-contracts.md) объединяет filesystem contracts, общий conformance gate и финальную приёмку этапа перед runtime06.
