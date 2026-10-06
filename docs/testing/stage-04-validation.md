# Приёмка этапа 04: local-llm и tools/os

Status: verified
Owner: repository maintainers

[План этапа](../plans/04-local-llm-tools-os.md), [приёмка OS](stage-04ab-validation.md), планы [downloads](../plans/04c-downloads.md), [server](../plans/04d-server.md), [backend/catalog](../plans/04e-backend-catalog.md). Выполнено 2026-10-06 после разрешения пользователя на параллельную работу.

## Организация и способ интеграции

Два OS worker write sets разработаны одновременно; затем три local-llm write sets выполнялись параллельно. Один integrator владел public index/registration, external/cross-owner references, diagnostic ledger, общей документацией и final checks. Read-only local-llm audit шёл одновременно с OS implementation и заранее обнаружил source-depth-sensitive asset resolver. Параллельность не означала совместное редактирование общих файлов или пропуск проверки.

Всего 165 moves: 78 OS и 87 local-llm. Downloads — 17 source + 12 suites; server — 11 + 11; backend/catalog — 19 source + 16 suites + GGUF byte fixture. Root index, backend-paths/source disk layout, chat-templates/source-relative dev/npm/SEA lookup и их tests оставлены намеренно. Existing archive/read-document/git/proc/web-search/shell-command-guard owners сохранены. Каждый owner получил guide с entry points, state/resources/operations, cross-owner seams и checks. Новых barrels/forwarders нет.

В local-llm retargeted 38 внешних/межобластных consumers, включая compatible public index и config/LLM/runtime/CLI/TUI seams. Механические proofs /tmp/atomic-stage04-os-proof.mjs и /tmp/atomic-stage04cde-proof.mjs сравнили все 2371 TS/TSX modules каждой фазы. Допустимы только записанные module literals и отдельно описанные fixtures. Все 4855 production graph edges local-llm фазы совпадают со snapshot после подстановки новых путей: это проверка неизменности DAG, а не только отсутствия SCC. 231 named public local-llm exports сохранены; root disk/asset resolver bodies прежние. Дополнительный proof первоначально слишком строго сравнил chat-template type-import с прежним адресом каталога; ожидание исправлено на разрешённую и записанную замену этого import literal, production код не менялся.

## Долг типов и assertions

OS: 14 resolved cases, 892 → 878. Local-llm: 22 resolved cases, 878 → 856; downloads 16, backend 6, server debt отсутствовал. Исправлены typed mutable callback holders для promise-closure releases, checked array indices, job fields waiting/resumable, unused vi import и GpuDevice fixture freeMemMiB. Полный gate подтвердил именно эти resolutions. Compiler options/TS version/allowances не расширялись, capture/rebase не выполнялся.

Assertions сохранены с двумя явно разрешёнными fixture-only нормализациями: progress compare использует проверенные current/previous aliases вместо unchecked seen[i]/seen[i-1]; один GPU fixture внутри expect получил недостающее neutral freeMemMiB=0. Matchers, исходные значения и проверяемые отношения прежние. Proof подставляет aliases обратно/удаляет только это added field и сравнивает прежние expect calls. Не утверждаем полное byte identity fixtures или отсутствие всего test debt.

OS mover failures/restoration описаны в своей приёмке. Во время parallel local-llm переноса промежуточные focused коллекции не всегда резолвили old cross-owner/config paths; они не объявлялись успешными. Источники snapshots и exact edits сохранены в /tmp/atomic-stage04{a,b,c,d,e}-*. После единой integration все такие suites покрыты успешным full runner.

## Итоговые проверки

Full test:ci: 1042 suites, 12445 tests passed, 4 existing platform/GC skips; exit 0. Предыдущая OS acceptance также прошла полный runner. Backend/catalog integrated focused: 17 suites / 227 tests, включая root backend-paths; server independent focused: 3 / 22. Production lint и build проходят; compiled dist/local-llm/index и dist/tools/os/index импортируются и содержат ожидаемые entry functions. Build выполнял обычный tsc/copy-starter-skills, release/sign/upload не запускались.

typecheck:tests: 2371 roots, 105 test TSX, 856 explicit debt, no new errors. imports:check: 1349 modules, 4855 local edges, 0 runtime SCC, 0 ownership exceptions. Import self-tests 36, docs self-tests 11, type self-tests 11, quarantine self-tests 8 passed. Registry 0 active / 2 released; docs budgets/links/metadata и git diff --check проходят. Exact FS test-helper и catalog GGUF fixture production imports запрещены с negative/positive tests; initial negative failures проверили расширение policy. Graph membership/options не ослаблены.

Package/package-lock/protected SHA hashes сохранены: .pr-review-56/EVIDENCE_ROUTER_MODEL.md, dependencies/versions unchanged. Source bodies, runtime assembly, config defaults/версии, prompt literals, tool names/descriptions/schemas/classification/registration order, persisted job/disk formats/env/CLI contracts и алгоритмы не менялись в этом этапе.

## Ограничения и следующий этап

Не выполнялись настоящие downloads/GPU/server starts, пользовательские shell/file operations, credential submission, manual terminal/platform QA, hosted CI/optional-canvas leg. Existing tests используют temporary fixtures/mocked subprocesses/local HTTP/browser servers и не заменяют live deployment validation. Текущий catalog не содержит template overrides, поэтому его старый template suite не даёт полноценного asset-path coverage; сохранение resolver source depth/body исключает новый переносный дефект, но не создаёт нового покрытия. Скорость/качество правок агента количественно ещё не сравнивались.

Весь этап 04 verified; отдельный [план 05](../plans/05-config-tool-contracts.md) specified, его реализация ещё не начата. Общая программа остаётся in-progress.
