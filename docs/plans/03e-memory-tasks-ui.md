# Срез 03e: представления memory/tasks

Status: verified
Owner: repository maintainers

Часть [этапа 03](03-tui-organization.md), определена после [приёмки local-models UI](../testing/stage-03d-validation.md). [Приёмка 03e](../testing/stage-03e-validation.md) завершена: девять views у владельцев, 16 fixture cases устранены (922 → 906), полный набор проходит. Следующий [срез 03f](03f-skills-import-ui.md) specified; весь этап 03 ещё in-progress.

## Контекст, цель и решение

UI памяти проецирует profile/notes/lessons/procedures/links/votes и детали записей; UI задач показывает расписания, историю запусков, создание и подтверждение отмены. У обеих функций state, reducer, input и orchestrator уже находятся в tui/memory и tui/tasks, но девять представлений остались в components. Их реальные операции выполняют домены memory/tasks через runtime.

Перенести три memory и шесть tasks views рядом с владельцами. Сначала отдельным изменением исправить известные ошибки двух reducer fixtures, затем выполнить два механических переноса. Объединение выбрано для двух малых законченных областей с общим DebugPane, а не для массового переезда остальных панелей. Config/storage/runner алгоритмы, refresh timers и глобальный TuiState/TuiAction API сохраняются.

## Фактическая карта после 03d

### Memory

Из components в tui/memory: memory-panel.tsx, memory-list.tsx, memory-detail.tsx. Panel использует filter/state и свои list/detail; внешний production-потребитель — DebugPane. Уже рядом: actions/reducer/state/keys/filter/summary/detail-text/orchestrator и два suites filter/reducer. Отдельных component tests сейчас нет.

Сохранить видимые channels, notes archive filter, search/cursor и детали/neighbor projection; мышь должна использовать тот же handler, что и клавиатура. MemoryOrchestrator остаётся владельцем своего auto-refresh timer и runtime reads, а доменные memory stores — владельцами данных/SQLite. Смена расположения view не является изменением recall/consolidation политик.

### Tasks

Из components в tui/tasks: tasks-panel.tsx, tasks-list.tsx, tasks-detail.tsx, tasks-filter-bar.tsx, tasks-create-form.tsx и tasks-cancel-modal.tsx. Уже рядом: actions/state/reducer/keys/filter/list-fit/summary/form-validator/cron-preview/orchestrator и шесть pure/reducer suites.

Внешние production-потребители: DebugPane → TasksPanel, TuiApp → TasksCancelModal, tasks-key-bindings → focusAfter из tasks-create-form. Последнее ребро остаётся локальным после переноса. Не извлекать focus helper одновременно с rename; если это понадобится для отдельной границы input/view, рассмотреть отдельно без изменения navigation порядка.

Cancel modal сейчас рендерится TuiApp отдельно от panel над editor, а не внутри таблицы; эту композицию и precedence сохранить. Recurring cancel требует подтверждения, one-shot следует существующему пути без modal. Create form сохраняет kind/expression/tz/message focus order, validation/preview и submit/error/busy state.

В этих девяти source-файлах нет одноимённых tests для переноса; существующие tests остаются у своих нынешних owners. История firings в TUI — наблюдение diff task records в orchestrator, а не перенос ownership taskRunner в view.

## 03e-1. Отдельно очистить 16 ошибок reducer fixtures

В memory-reducer.test записано пять случаев: неполный TuiSessionInfo, чрезмерно узкий inferred state detail-mode и три excess-property ошибки на action objects (rows/rowKey/direction). В tasks-reducer.test — один неполный session fixture и десять action-object случаев (confirm, delta, direction, entry×2, error, rows×2, taskId×2). Всего шестнадцать, не число fingerprint records.

Дополнить session через общий fakeSession с сохранением явно заданных старых полей/значений либо задать все обязательные поля явно. Дать составному state тип TuiState. Actions проверять по реальному MemoryAction/TasksAction или общему TuiAction: typed constants/satisfies либо локальный типизированный test seam к существующему reducer. Production reducer принимает {type:string} для fall-through; не расширять его signature/guard или менять API ради fixture.

Сохранить события, payloads, все assertions и unrelated-action fall-through. Не использовать any/casts/Record<string,unknown>, не отключать excess-property checks и не удалять тесты. Выполнить существующие memory/tasks suites и type gate, затем reduce; ожидаемая база — 906 при устранении ровно 16 и отсутствии новых ошибок. Проверить multiplicity явно; capture/rebase запрещён. Если реальный action contract выявит другую проблему, разобрать её отдельно, а не разрешать новую диагностику.

## 03e-2. Проверить seams и перенести views

Прочитать tui/AGENTS, interface guide, memory/tasks/runtime инструкции и соответствующие guides по обе стороны операций. Повторить graph/rg inventory и snapshots до fixtures/после них. Сверить существующее покрытие:

- memory channels/search/notes filter, clamp cursor, list/detail и unrelated-action fall-through;
- tasks status/search, текущее окно списка с фиксированными колонками, create kind/focus/preview/error и recurring cancel target; tasks-list-fit проверяет отдельный helper, который TasksList не использует, и не является доказательством полного layout budget;
- TuiApp tasks search/input и app key precedence; DebugPane row budgeting/composition;
- orchestration timer/store/runner границы по фактическим existing suites, без заявления что reducer tests покрывают side effects.

Использовать существующие checks. Если конкретное изменяемое поведение не покрыто, добавить небольшую meaningful проверку отдельно от rename; не писать test только на новое расположение. Тесты с runtime/config используют typed seams и временные данные, не персональное состояние и не настоящий task execution/provider.

Перенести memory views, затем tasks views, исправляя все consumer/mock/import-type/literal dynamic targets и актуальные комментарии. Не оставлять forwarding modules, не вводить barrel или обязательные view/state/input подпапки. Все bodies и exported names сохранить; сравнить каждую группу и callers с snapshot без module paths/comments.

## Инварианты, ограничения и приёмка

Сохранить обязательные runtime/domain ownership и read/approval boundaries. Представления получают состояние/callbacks; они не получают новые store/runner ресурсы. Auto-refresh/shutdown и bus subscription ownership не меняются. Политики памяти, clock/timezone/cron semantics, task schedule/firing/cancel алгоритмы, public callbacks и global action types не затрагивать. Config defaults/версии, prompt и runtime bootstrap остаются прежними. .pr-review-56/ и EVIDENCE_ROUTER_MODEL.md не трогать.

Создать memory/README и tasks/README с маршрутами view/state/input/orchestrator/tests, владельцами данных/timers и реальными composition points. Обновить parent/interface navigation без пустых AGENTS. Девять source-модулей у владельцев, старые пути отсутствуют, assertions fixes сохранены и mechanical bodies доказаны. Долг не вырос; оставшиеся diagnostics вне среза явно сохранены.

Focused memory/tasks/app input/DebugPane и нужные seam suites проходят; lint, type gate, imports:check (ноль SCC/исключений), docs/checker self-tests, git diff --check и полный test:ci проходят. Отсутствие отдельных component/orchestrator suites и ручного terminal QA обозначить как ограничение, если они не выполнены, а не считать их автоматически покрытыми.

После записи evidence отметить 03e verified. Затем специфицировать следующий небольшой набор остальных панелей (skills/import и дальнейшие owners по фактическому дереву). Этап 03 остаётся in-progress до их завершения и итоговой shared UI границы; план 04 ещё не создавать.
