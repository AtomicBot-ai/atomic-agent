# Срез 03i: оставшиеся владельцы TUI и итоговая граница

Status: verified
Owner: repository maintainers

Определён после [приёмки 03h](../testing/stage-03h-validation.md). Пользователь разрешил завершить оставшийся TUI одним непрерывным проходом; внутри сохраняются отдельные snapshots, механические группы и проверки. [Этап 03](03-tui-organization.md) принят; [evidence](../testing/stage-03i-validation.md).

## Решение и область

Theme chooser получает tui/theme-picker; shared palettes/color math остаются в theme, иначе общий цветовой слой будет импортировать конкретный chooser. Четыре observation views (event-feed/logs-tab/reasoning-tab/world-panel) переходят из корня в observe. Chat presentation, message projection/error formatting и существующие tests переходят в chat; ChatOrchestrator остаётся общей runtime/session композиционной точкой, несмотря на историческое имя.

Coding-mode popup/chip/plan-handoff и coding-mode helpers/tests переходят в coding-mode. Session picker/delete views и picker test — в уже существующий session-rail. Context panel/chip, keys/selectors и существующие suites — в context. Глобальные state/actions/reducers/router/submit, layout, menu, approval и TuiApp сохраняются; их composition suites остаются у общей сборки. Уже локальные privacy/integrations/swarm/telegram не flatten: добавить guides с владельцами и точными checks.

Не переносить TypeScript domain modules, не изменять алгоритмы, exports/публичные callback shapes, config/runtime/prompt/packaging. Старый context-usage-from-prompt facade остаётся без новых forwarding modules. Если shared logo зависит от типов splash layout, выделить только два type aliases в shared owner с проверкой неизменности aliases; types не дают shared view права импортировать chat implementation.

## Порядок и достоверность

Перед кодом сохранить исходный src, debt и package/protected hashes. Cleanup устаревших fixtures выполнять отдельно: пять неполных chat sessions через fakeSession с прежними explicit values; полный typed callbacks в switch-back fixture; configure-fallback fixture перевести с удалённого MouseProvider.value на актуальные props и убрать unused vi; недостающие context view/state defaults добавить без изменения прежних values/assertions. Ожидается десять разрешённых диагностик, 902 → 892; фактический type gate определяет итог. Capture/rebase, casts, новые allowances и ослабление options запрещены. Configure-fallback suite проверяет action contract/label, а не полноценный click: не объявлять её доказательством мышиного ввода.

Затем отдельными группами theme/observe, chat, coding-mode/session/context выполнить moves с retarget всех consumers, mocks, dynamic/type literals. До каждой группы snapshot; после — exact comparison всего TS/TSX source только по записанным module literals. Не добавлять barrels/forwarders. Для двух shared aliases отдельная точная проверка declaration text/exports и остальные source bytes.

README каждого владельца описывает views, state/input/resource ownership, composition entry points, domain boundaries, tests и известные coverage limits. Parent guide и interface ведут к каждому владельцу. Оставшиеся components явно разделяются на shared primitives и shell composition; глобальная сборка вправе соединять features, generic editor/logo/list/formatting не вправе использовать их реализацию.

После чтения scripts instructions расширить imports checker только на подтверждённые shared primitives и theme. Проверить negative fixtures (shared view/type import → chat/chooser/context/domain) и positive shell composition. Не вводить запрет всех feature-to-feature imports, лимит глубины или искусственную унификацию файлов. Никаких новых dependencies/exceptions.

## Приёмка

Focused TUI suites до/после fixture cleanup/moves, lint, test types, imports (0 runtime SCC/0 exceptions), docs/link budgets, все checker self-tests, quarantine и diff check. Полный test:ci после итоговой структуры с loopback fixtures. Protected/package hashes, unchanged code/aliases и неизменные прежние expect calls проверяются отдельно; counts записываются фактически.

Manual terminal/platform QA, hosted CI и живые provider/installer operations не выполнять и не выдавать за проверенные. Отсутствующие individual observe/theme picker suites явно отметить. После evidence и final inventory отметить 03i и весь 03 verified, затем только создать план 04 по фактической организации local-llm/tools/os. Реализация 04 в этот проход не входит.
