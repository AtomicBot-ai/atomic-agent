# Этап 04: организация local-llm и tools/os

Status: verified
Owner: repository maintainers

[Общий маршрут](project-reorganization.md). Создан после [приёмки всего TUI](../testing/stage-03i-validation.md). Реализация начата. Пользователь разрешил параллельную работу: независимые filesystem и shell/web срезы разрабатываются одновременно; root registry/внешние imports/type ledger и итоговая приёмка выполняются одним интегратором. local-llm уточняется отдельно по графу, его переносы следуют после этой приёмки. База: 892 test type diagnostics, 0 runtime SCC/ownership exceptions; full CI-equivalent 1042 suites / 12445 passed / 4 skips.

## Контекст и решение

local-llm управляет отдельными assets/download workers/llama-server, а tools/os регистрирует операции файлов, shell и web. После организации TUI их интерфейсы находятся у UI владельцев, но доменные реализации по-прежнему плоские: local-llm — 51 production и 41 test module в корне; tools/os — 50 production и 37 test modules в корне плюс уже самостоятельные archive/read-document/git/proc/web-search/shell-command-guard.

Цель — собрать операции по ответственности, сохранив состояние на диске, детач worker, владение процессами и tool contracts. Начать с наиболее механического набора tools/os/fs; затем уточнять downloads/server/catalog/backend по фактическому графу после каждого принятого среза. Не переносить существующие вложенные области ради одинаковой глубины. Общие approvals, config, runtime dispatch и TUI остаются у своих владельцев.

## 04a: файловые операции — подробно определённый первый срез

Читать tools/AGENTS и docs/contracts, tools/os/README; approval/session/config instructions по пересекаемым контрактам. Перед реализацией повторить inventory потребителей/mocks/literal imports и diagnostic fingerprints: данные ниже описывают момент приёмки 03.

Перенести все текущие root fs-*.ts и fs-*.test.ts в tools/os/fs с сохранением имён: 27 modules и 17 tests. В 27 входит fs-locate-project-test-helpers.ts — test helper, хотя имя не .test; не называть его runtime operation или разрешать production импортировать его. Набор: read/read-coverage/list/glob/grep/hash/diff/watch; write/edit/edit-diff/patch/patch-preview/trash/restore/store/manifest; input/replace/content/parse/approval guards и declared inputs; project location/sources/test helpers. archive и read-document остаются отдельно; shared expand-home и registry index.ts остаются в root os.

Сначала snapshot src, debt и package/protected hashes. Если переносимые tests имеют debt, отдельным шагом исправить реальные fixtures с сохранением values/assertions и reduce только resolved cases. Для сохранённого diagnostic нужен узкий доказанный path migration, а не общий capture/rebase; новые errors запрещены. Затем moves/retarget consumers во всём src и scripts, включая type references/mocks/dynamic imports. Root os/index.ts сохраняет текущие exports/registration order, но с новыми путями; не добавлять новый fs/index только ради directory convention и не оставлять forwarding modules на старых путях.

Отдельный source proof сравнивает все bodies/exports/prompt descriptions/schema/parser semantics и registry order: допустимы module literals и documentation comments. Существующие input-file/declared inputs/approval retarget, replacement refusal, parse/content checks, read-root scopes, restore manifest/backup behavior и locate-project known-source policy неизменны. Не объединять relocate с исправлением обнаруженного алгоритма.

Создать fs/README с операциями, guards, owner FileRestoreStore/DeclaredInputsRegistry, действительными consumers/registration и checks. Обновить OS/tools/TUI/domain references и активные document links, сохранив исторический материал. Считать domain persistence отдельным от feature UI, а guarded fs tool отдельным от agent batch/approval policies.

Проверки: соседние fs suites; os-tools registration; agent/tool-resource-class и tool roles; affected declared-input/approval/restore seams; lint, type gate, imports (0 SCC/exceptions), docs/self-tests/quarantine и diff. Full test:ci с существующими loopback fixtures. Не проверять через настоящие пользовательские файлы: temporary dirs и существующие mocks. После evidence 04a verified, затем следующий подробный срез.

## Последующие срезы — planned, уточнять последовательно

1. **Shell и web.** tools/os/shell собирает shell/result/timeout/detach/jobs/calls/interpretation/guard policy с tests; существующий shell-command-guard может сохранять своего владельца. tools/os/web собирает fetch/challenge/extract/SSRF и HTTP request/retry/transport helpers по реальной зависимости; web-search остаётся самостоятельным owner. ensure-curl/html-to-text/retry-after/expand-shell-glob-args классифицировать по consumers, не по префиксу. Сохранить tool names/registration/approval, detach rather than kill on timeout, shell registry ownership, response/SSRF bounds, provider fallbacks и control-marker defenses.
2. **Downloads.** local-llm/downloads собирает download transfer/attempt/errors/partial/resume/segments/rebalance/settings, jobs/staleness/notify/seed и detached worker/spawn/pair. Model/backend installer относится к installs/downloads либо backend owner по графу: не копировать transfer ради разных assets. Worker запускается через runtime.selfInvocation как `models pull-worker`, не через URL собственного модуля; сохранить argv/env/SEA/Windows framing, job/log/partial пути и версии. Проверить также CLI/background-pull и TUI orchestrator seams.
3. **Server lifecycle.** local-llm/server собирает daemon lifecycle/launch guard/port holder/reclaim/API key/session registry/worker slots/log tail/fault и реально общие process helpers. External mode не приобретает права kill; managed restart/stop/stopOnExit сохраняют owner records, chat/embedding pairing и capability refresh. Не менять портовую политику или startup/shutdown order попутно.
4. **Catalog/backend.** Отдельные владельцы curated/custom/HF/GGUF/template metadata и backend assets/platform/staging/version/auto-update/fallback/GPU policy определяются по actual consumers. backend-paths остаётся единым источником disk layout, а путь исходного файла не становится новым persisted path. Public local-llm/index сохраняет контракт именованных экспортов и намеренную композицию; внутренние owners не импортируют собственный root index, если это вернёт циклы. Public API narrowing относится к более поздним этапам.

Для каждого среза новый короткий numbered subplan после предыдущей приёмки, отдельные fixture cleanup/move proofs и focused checks. Не выполнять массовый rewrite всех четырёх областей по этому предварительному перечню. Новые boundary rules вводить только по подтверждённым зависимостям с negative/positive fixtures; существующие domains → interfaces запреты сохраняются.

## Приёмка и границы этапа

Filesystem/shell/web/downloads/server/catalog/backend имеют явных владельцев и локальные маршруты code/state/resources/tests. Источники перемещены отдельно от алгоритмов, consumers/mocks/scripts/docs актуальны, публичные exports/tool contracts/disk formats/env/CLI/config/prompt/runtime неизменны. Нет новых SCC/exceptions/type allowances, выбранные seams и полный runner проходят. Protected .pr-review-56, EVIDENCE_ROUTER_MODEL.md и package/dependency versions сохраняются.

Реальные downloads, llama-server/bot starts, external network calls, package release и пользовательские filesystem mutations не входят в verification. Ручные/platform/hosted checks описываются честно. После всей приёмки 04 verified только тогда создавать план 05: схемы и контракты. Монорепозиторий, независимые packages, runtime/agent-loop перестройка и устранение всего type debt не входят в этот этап.

## Фактическая приёмка и следующая параллельная фаза

[04a/04b verified](../testing/stage-04ab-validation.md): FS/shell/web перенесены, debt 878, full suite прошёл. По отдельному actual graph audit определены downloads/server/backend/catalog maps; три непересекающихся worker write sets выполняются параллельно с одним integrator для index/consumers/ledger/docs. Пользовательское разрешение parallel work уточняет прежнюю последовательность срезов; все критерии проверки сохраняются.

## Итог

[04 verified](../testing/stage-04-validation.md): OS и три local-llm write sets приняты; 165 moves, неизменные API/DAG/paths, debt 856, lint/build/full runner и checker suites прошли. Root resolvers оставлены намеренно. Следующий [план 05](05-config-tool-contracts.md) specified, код ещё не изменён. Историческая исходная карта и порядок уточнения сохранены выше.
