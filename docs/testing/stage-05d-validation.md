# Приёмка 05d: конфигурация вебхуков

Status: verified
Owner: repository maintainers

[План 05d](../plans/05d-webhook-config.md), [этап 05](../plans/05-config-tool-contracts.md). Выполнено 2026-10-06. Production agent владел schema/new owner; test agent — новым parser/schedule seam suite; read-only agent подготовил следующий MCP slice; integrator владел snapshots, boundary и проверками.

## Изменение и доказательства

WebhookConfig, parseWebhookMap и private parseWebhookSchedule перенесены в webhook-config.ts. Dependencies — existing error/primitive и type-only TaskSchedule. Root type/parser exports и config/index/consumers/default/version/migrations не изменились. HTTP materialization и TaskRunner canonical schedule validation остались прежними. Schema 5857 → 5707 строк, owner 161 строка.

Exact source proof проверил три declarations/bodies/comments и весь оставшийся schema text, совместимые exports и правильные imports; parent proof — remaining AST statements, 87 public names, 2374 прочих прежних TS/TSX modules и protected/package/compiler/debt hashes. Before snapshot /tmp/atomic-stage05d-before снят до extraction. Совпали 74 webhook cases по direct/root outputs/errors, 369 scalar cases, 107 rail cases, 76 version/file cases и полные defaults. Fresh empty map identity проверена. Compiled smoke подтвердил parser/error identity и deferred schedule shape. Test ledger не менялся; casts/allowances/dependencies не добавлялись.

Новые 27 tests закрывают actual gap: root/leaf API/error identity, whole-file assembly, optional null omission, modes/name/whitespace и точные fields/reasons/messages, формы schedule и отдельную границу load/dispatch. Interval=1 и invalid nonempty cron загружаются по прежней shape policy; validateSchedule отвергает их при исполнении. Existing HTTP tests не заменялись и покрыты полным runner.

## Проверки

- Focused config/task-schedule/CLI: 23 suites, 562 tests passed. New webhook owner: 27 passed; extraction schema: 219 passed.
- Full test:ci: 1044 suites, 12498 passed, 4 existing platform/GC skips; exit 0, 37.12 s. Разрешённый loopback/home-fixture доступ; quarantine прежний.
- lint/build и compiled smoke passed. typecheck:tests: 2377 roots, 105 test TSX, прежние 856 diagnostics, no new errors.
- imports:check: 1353 modules, 4866 edges, 0 SCC/exceptions. Self-test 53: новые static/type/dynamic root backedge negatives сначала failed без policy; inward/error/primitive composition разрешена.
- Docs self-test 11 passed, docs:check/budgets/links/metadata и diff прошли после сохранения приёмки/следующего плана. Type/quarantine checker не менялись; прежние self-tests не повторялись. Quarantine не расширялся.

Artifacts: /tmp/atomic-stage05d-{before,proof.mjs,webhook-proof.mjs,webhook-extraction.json,webhook-values.mts,*-tests.txt}. Live webhook outside test harness, paid providers/GPU/model eval/manual terminal QA не запускались. Synthetic secrets only; no user credentials or personal config writes. Differential не исчерпывает все raw inputs; exact bodies и существующие tests дополняют его.

05d verified; [05e](../plans/05e-mcp-config.md) следующий joint owner slice. Весь 05 остаётся in-progress; defaults/migrations/remaining domains и contract families ещё предстоят.
