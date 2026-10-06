# Срез 03b: providers/LLM UI и потребители composer

Status: verified
Owner: repository maintainers

Часть [этапа 03](03-tui-organization.md), создана после [приёмки MCP](../testing/stage-03a-validation.md). Срез принят: [результаты проверки](../testing/stage-03b-validation.md). Следующий срез определён в [плане 03c](03c-onboarding.md).

## Контекст и цель

Provider wizard и LLM panel уже имеют собственные state/keys/orchestrators, но их представления находятся в общем components/. Composer использует из того же каталога llmHealthLook; onboarding использует мастер и его измерение. Это функции с конкретными владельцами, а не общие UI-примитивы.

Цель: разместить девять source-модулей и семь тестов рядом с владельцами, сохранив live switching, проверку ключа, modal/input поведение и явную композицию между функциями. Не объединять все области в новый общий каталог.

## Фактическая карта после 03a

### Providers

Перенести из tui/components в tui/providers:

- providers-panel.tsx;
- providers-wizard.tsx;
- providers-wizard-measure.ts;
- cloud-provider-onboarding.tsx;
- providers-wizard.test.tsx, providers-wizard-measure.test.tsx, cloud-provider-onboarding.test.tsx и cloud-provider-onboarding-mouse.test.tsx.

Wizard используется ProvidersPanel, LlmPanelModals, onboarding-step-body и отдельным CloudProviderOnboarding. Измерение используется wizard и onboarding-surface-layout. В текущем production-графе отдельный CloudProviderOnboarding не имеет потребителей; его tests/API сохраняются — это не разрешение удалять компонент как неиспользуемый.

### LLM panel

Перенести в tui/llm-panel:

- llm-panel.tsx, llm-panel-modals.tsx, llm-mode-rows.tsx;
- llm-panel.test.tsx и llm-mode-rows-cloud.test.tsx.

Перенести llm-fallback-rows.tsx и llm-fallback-rows.test.tsx в tui/llm-panel/fallback, рядом с уже существующим fallback state/input/orchestrator. DebugPane остаётся общей точкой сборки. LLM panel продолжает композицию local-models views; их перенос относится к следующему отдельному срезу.

### Health и composer

Перенести llm-health-badge.tsx в tui/llm-health. Его llmHealthLook принимает health status и ground, а цвета выводит из темы. ComposerBackendControl — текущий production-потребитель; он должен импортировать helper у владельца health. Composer-switch уже имеет собственные view/state/keys/rows/tests, поэтому его файлы целиком не переносить.

Сохранить намеренный composer → LLM primary activation/preflight: он использует тот же путь переключения, а не второй алгоритм. Не запрещать это ребро ради искусственной изоляции функций.

## Проверки перед переносом: шесть конкретных диагностик

Среди семи перемещаемых тестов есть шесть записанных диагностик:

- cloud-provider-onboarding-mouse: отсутствуют четыре обязательных callback, плюс неиспользуемый React import;
- llm-fallback-rows: callback fixture неполный;
- llm-mode-rows-cloud: обязательный subscriptionCli отсутствует в default fixture: Partial override оставляет его потенциально undefined вместо null/объекта по контракту ProviderRow;
- providers-wizard-measure: неиспользуемый React import;
- providers-wizard: vi.fn с нулевым tuple аргументов, хотя проверка читает первый аргумент вызова.

Сначала отдельным небольшим изменением исправить именно эти fixtures: дополнить обязательные callbacks, задать реальные типы override/model/spy, убрать неиспользуемые imports. Assertions и проверяемые события сохранить; не заменять типы cast/any и не удалять тесты. Запустить семь тестов и type gate, затем typecheck:tests:reduce. Ожидаемая база — не более 941, если устранены все шесть и не найдено новых ошибок.

После этого сами перемещаемые тесты не несут debt, поэтому перенос не должен требовать разрешения ошибок по новым путям. Если сообщения в других fixtures меняются только из-за экспортного пути, рассмотреть каждую точную миграцию отдельно с AST-сравнением и неизменной multiplicity; capture/rebase всего долга запрещён.

## Последовательность изменений

1. Прочитать tui/AGENTS.md и README, config/llm/local-llm инструкции по сторонам используемых интерфейсов. Подтвердить потребителей через TypeScript import graph и rg; зафиксировать snapshot до переноса.
2. Очистить шесть диагностик перемещаемых fixtures отдельно от source moves и уменьшить базу только после проверки.
3. Перенести providers source/tests и обновить consumer/mock/import-type адреса, включая onboarding. Оставить generic pick-list, geometry, printable input, mouse/context-menu/theme общими. Providers/wizard-pick-list уже находится у владельца и не переезжает обратно.
4. Перенести LLM/fallback source/tests. Сохранить файл modal composition, URL parsing и hasLlmModal API; helper extraction или устранение отдельного дефекта — другое изменение, если выявится необходимость. Не менять window budgets, hotkeys, фильтр, defaults и prompt/schema.
5. Перенести health view/helper и обновить composer import; сохранить page/rail palette и статусные glyphs без копирования таблицы. Проверить существующие composer route/popup/app и health poller suites.
6. Обновить guides для providers/llm-panel/llm-health и родительскую карту. Не создавать новые пустые AGENTS или barrel APIs. Найти и удалить старые import paths и временные forwarding files.
7. Сравнить source bodies/исполняемый output без импортов и комментариев; проверить imports:check (ноль SCC/исключений), lint, test type gate, docs и полный test:ci.

## Поведение и ограничения

Сохранить проверку provider credentials перед save, abort/unmount guard отдельных wizard mounts, persisted/live partial success, model rollback, role/default/env mappings и активные provider pins. Форматы config и типы публичных commands/callbacks не меняются. Перенос не меняет асинхронные catalog fetch effects wizard; перенос внешних операций из views в controllers при необходимости потребует отдельного среза с тестами.

Onboarding и LLM могут использовать ProvidersWizard как конкретную композицию; общий список не импортирует wizard. Health helper принадлежит области health и используется composer явно. Остальные local-models/onboarding/panel views остаются на своих нынешних местах до их собственных карт переноса.

Не исправлять попутно весь TUI debt, не менять provider SDK/transport, runtime bootstrap, LLМ literals, download/daemon алгоритмы, конфигурационные версии и публичные CLI/HTTP команды. Не трогать .pr-review-56/ и EVIDENCE_ROUTER_MODEL.md.

## Приёмка

Девять source-модулей и семь тестов находятся у указанных владельцев; старые пути отсутствуют. Поведение сохранено и source moves подтверждены сравнением; fixes шести test diagnostics рассмотрены отдельно. База не выросла, moved fixtures чисты. Navigation однозначно ведёт к view/state/input/orchestrator/tests и cross-feature composition points. lint, types, imports/docs gates и полный test:ci проходят; keyboard/mouse wizard, modal, live provider/fallback и composer seams покрыты существующими проверками.

Срез становится verified только после этих условий. Затем уточнить срез 03c об onboarding по фактическому состоянию. Весь этап 03 остаётся in-progress до завершения остальных срезов; план 04 о local-llm/tools создаётся после его полной приёмки.
