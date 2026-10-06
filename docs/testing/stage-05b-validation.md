# Приёмка 05b: конфигурация списка сессий

Status: verified
Owner: repository maintainers

[План 05b](../plans/05b-session-rail-config.md), [этап 05](../plans/05-config-tool-contracts.md). Выполнено 2026-10-06. Extraction agent владел двумя config modules, два read-only agents исследовали следующую config область и точный hash prototype; integrator владел snapshots, boundary и общей приёмкой.

## Изменение

SessionRailConfig, parseSessionRailConfig и private parseSessionIdList выделены в session-rail-config.ts. Единственная runtime dependency — существующий ConfigValidationError. Schema явно импортирует и сохраняет прежние type/function exports; config/index и consumers не изменены. Schema 5902 → 5857 строк, leaf 64 строки. Перенесены только два rail comments; соседние onboarding/notify comments сохранены в root. Defaults, version=74, migrations, env precedence и TUI session existence/cleanup не изменились.

Два независимых proofs сравнили exact moved declarations/type/function bodies, оставшиеся root AST statements и unmoved schema text; 87 public names и 2371 остальных TS/TSX files неизменны. Сохранены package/lock/compiler/debt/protected hashes. Differential: 107 rail cases (block/list absence/null/nonarray, filtering/dedup/order/whitespace и errors), 369 scalar cases, 76 file-parser/version cases и полные USER_CONFIG_DEFAULTS/ENV_DEFAULTS совпали. Fresh arrays проверены отдельно. Compiled smoke подтвердил identity parser через schema/index/leaf и прежний error class/field/reason.

Snapshots/proofs/logs: /tmp/atomic-stage05b-before, /tmp/atomic-stage05b-{proof.mjs,rail-proof.mjs,values.mts,rail-values.mts,*-tests.txt}. Это временное доказательство приёмки, не новая обязательная toolchain.

## Проверки

- Focused config/CLI/TUI: 29 suites, 602 tests passed. Extraction focused schema: 219 passed.
- Full test:ci: 1042 suites, 12445 passed, 4 existing platform/GC skips; exit 0, 55.90 s. Разрешённый runner сохранил loopback/home fixtures, quarantine не расширялся.
- lint/build passed, compiled API/error/fresh-array smoke passed.
- typecheck:tests: 2373 roots, 105 test TSX, прежние 856 diagnostics, no new errors. Ledger/capture/reduce/options не изменялись.
- imports:check: 1351 modules, 4859 edges, 0 SCC, 0 exceptions. Четыре новые fixtures подняли self-test до 45; negative прежде failed на старой policy, затем static/type/dynamic direct schema/index backedges блокируются, inward/error-owner разрешены.
- Docs self-test 11 passed; quarantine 0 active/2 released; docs:check и diff проходят после сохранения acceptance/следующего плана. Type/quarantine checker implementations не менялись; их self-tests не повторялись после прежней успешной приёмки 05a.

## Границы

Live-model/provider/GPU eval и manual terminal QA не выполнялись. Parser не получает доступ к session store и не удаляет stale ids; это остаётся UI behavior. Differential cases не исчерпывают все inputs; exact body proof и existing suites дополняют их. 05b verified, весь 05 in-progress; tool prototype, остальные domain blocks/defaults/migrations ещё не завершены.
