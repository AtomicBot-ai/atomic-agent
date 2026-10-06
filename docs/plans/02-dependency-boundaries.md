# Этап 02: границы зависимостей

Status: verified
Owner: repository maintainers

[Общий маршрут](project-reorganization.md). Этап 01 [завершён](../testing/stage-01-validation.md): production lint строгий, тестовая TS/TSX-программа запрещает новые диагностики, MCP fixtures очищены. Этап проверен: [результаты и ограничения](../testing/stage-02-validation.md).

## Контекст и цель

Сохранение provider config сейчас находится в TUI-модуле, хотя его используют каналы. Несколько циклов связывают представление, клавиатурный ввод и общие функции выбора строк. Изменение одной части интерфейса поэтому может загружать другую или требовать знания её внутреннего типа.

Цель: общие операции и UI-примитивы имеют своих владельцев, а новые нарушения импортов и циклы обнаруживаются автоматически. Алгоритмы сохранения, hot-swap и взаимодействия с оператором сохраняются.

## Фактическое состояние после этапа 01

Статический разбор production TS/TSX import/export 2026-10-06, без type-only рёбер, нашёл три компоненты с циклическими runtime-импортами:

1. Wizard: route-wizard-key → providers-wizard-key-bindings → providers-wizard-list-keys → components/wizard-pick-list → providers-wizard-paste → route-wizard-key; в ту же компоненту входит llm-panel-modal-key-bindings.
2. Onboarding: components/onboarding-wait-or-jump-step ↔ onboarding/onboarding-step-keys.
3. Composer: composer-switch-rows ↔ composer-switch-worker-rows.

Общая операция также связана с TUI через src/channels/model-command.ts → src/tui/persist-llm-provider.ts. Последний импортирует тип ProvidersWizardKind из состояния мастера. Это отдельная архитектурная зависимость, даже если type-only ребро не создаёт runtime-цикл.

В текущем src/cli нет найденного прямого импорта provider wizard: CLI index импортирует TUI entry point для запуска интерфейса. Это допустимый composition root, а не повод переносить общий код из CLI. Предыдущее предположение о CLI нужно заменить проверенным случаем channels → TUI. Исходный временный граф сохранён в /tmp/atomic-stage02-imports.json; реализация checker должна независимо воспроизвести рёбра через TypeScript resolution.

## Границы работ

Затрагиваются src/config, src/tui/providers, src/tui/llm-panel, src/tui/onboarding, src/tui/components, src/tui/composer-switch, src/channels/model-command.ts и scripts/CI. Читать инструкции config/tui/channels и по другую сторону изменяемого интерфейса. Не начинать общую организацию TUI, перенос local-llm, изменения provider SDK, runtime bootstrap или нового пакета.

Механические переносы отделять от изменения вызывающего кода. Не создавать общий utils-каталог без владельца или index.ts в каждой папке. Не исправлять попутно весь TUI type debt: новая диагностика запрещена работающим gate, а необходимое исправление старой выполняется отдельно с уменьшением базы.

## Последовательность небольших изменений

### 02a. Общие операции provider config

- Перенести операции чтения/записи provider block, upsert/remove, активных pins, default model, fallback chain и dotenv credentials из src/tui/persist-llm-provider.ts к владельцу конфигурации, например src/config/llm-provider-commands.ts. Внутри config использовать конкретные модули, не импортировать собственный public index и не создавать новый barrel-цикл.
- Определить нейтральный контракт ключевого provider kind для dotenv helpers. Мастер преобразует свой ProvidersWizardKind в этот контракт; shared module не импортирует wizard state. Сохранить прежние env-key mappings, trim, permission behavior и немедленное обновление process.env.
- Обновить каналы, provider orchestrator, fallback/run-mode и сохранение мастера на новый источник. При необходимости оставить краткий совместимый re-export на время одного небольшого изменения, затем убрать после проверки всех потребителей.
- Сохранить отказ при удалении активного text provider, scrub run-mode pins, rollback default model и порядок write/reset/live refresh. Тесты persistence и model-command должны проверять эти действия; runtime hot-swap остаётся у вызывающего orchestrator.

### 02b. Разорвать три UI-компоненты

- Wizard: вынести чистую геометрию списка (PICK_WINDOW/расчёт видимой области) и проверку printable filter input в UI-примитивы, не импортирующие wizard или view. Развести регистрацию mouse route, paste и keyboard routing так, чтобы общий список не тянул обратно владельца состояния мастера. Сохранить одну семантику mouse/keyboard, фильтр, PgUp/PgDn и модальный приоритет.
- Onboarding: перенести wait-or-jump status/row-count helpers из component к владельцу onboarding state/selectors. View и key handler импортируют их независимо; view не является владельцем поведения клавиатуры. Сохранить переходы ожидания/download/jump.
- Composer: вынести shared row contracts и общие pure selectors из composer-switch-rows/worker-rows в независимый модуль. Оба набора строк используют его; shared module не импортирует конкретный набор строк. Сохранить наличие моделей на диске, worker pins и выбор backend.

Перед каждым переносом подтвердить фактическое ребро и имеющиеся тесты; не разрывать цикл путём копирования той же логики в двух местах. Каждый цикл — отдельное небольшое изменение с focused tests и gate типов.

### 02c. Автоматическая защита границ

- Добавить scripts/check-imports.mjs на установленном TypeScript API: штатное разрешение относительных ESM .js → TS/TSX, static import/export и literal dynamic import. Отдельно учитывать type-only рёбра для архитектурных правил; для runtime SCC не считать полностью type-only declarations/specifiers.
- Запретить config/provider/shared domain modules импортировать TUI и каналы; запретить каналам импортировать TUI. Разрешить только явно именованный composition-root путь CLI index → TUI entry point. Внутри UI проверять разделение shared primitives и feature implementation без запрета всех feature-to-feature рёбер вслепую.
- Зафиксировать только просмотренные оставшиеся нарушения отдельными точными рёбрами с владельцем и основанием, если они действительно есть. Общие исключения вида «весь tui» или «весь config» не допускаются. Удалённые исключения требуют уменьшения списка; новые нарушения и новые runtime SCC блокируют PR.
- Неразрешённый локальный импорт должен быть ошибкой checker, а не исчезать из графа. Bare packages не считать локальными модулями. Test imports не использовать для production SCC; тестовую архитектуру учитывать отдельно при необходимости.
- Проверить временными fixtures: новый цикл, domain → UI, потерянный resolver target, смешанные type/value imports, допустимый type-only import и разрешённый composition root. Добавить imports:check в стандартный PR gate и локальный эквивалент CI.

## Приёмка

- Channels и shared provider-config операции не импортируют TUI ни значениями, ни типами; изменение wizard state не требуется для изменения общей операции.
- Три подтверждённые UI SCC отсутствуют в воспроизводимом графе; keyboard/mouse, onboarding wait/jump и composer worker semantics проходят существующие проверки.
- imports:check обнаруживает новое нарушение и цикл, не скрывает неразрешённый локальный импорт. Исключения точные, имеют владельца и не растут автоматически.
- Production lint, typecheck:tests, docs:check и затронутые persistence/channel/UI тесты проходят. База 947 диагностик не увеличивается; изменения её fingerprint из-за механического пути рассматриваются как отдельная объяснённая миграция, не как разрешение новой ошибки.
- Diff отделяет переносы от поведения; конфигурационная совместимость, env credentials, pins, live provider switching и публичные интерфейсы сохранены.

После приёмки создать план 03 организации TUI начиная с MCP. Фактические новые владельцы и доступные проверки должны определить его границы.

## Фактический результат

Общие provider commands находятся в config; три UI SCC устранены. imports:check работает на TypeScript resolution, negative fixtures проходят. Сохранено одно точное временное HTTP → TUI ребро сохранения MCP, обнаруженное при подготовке следующего этапа; его перенос назначен этапу 03a. Production lint и полный набор тестов проходят, типовой долг остался 947 без изменения базы. [План 03](03-tui-organization.md) создан после приёмки.
