# Этап 03: организация TUI по функциям

Status: verified
Owner: repository maintainers

[Общий маршрут](project-reorganization.md). Создан после [приёмки этапа 02](../testing/stage-02-validation.md). Все срезы 03a–03i и итоговая граница shared UI приняты; [итоговое evidence](../testing/stage-03i-validation.md). Ниже сохранены исходные карты и последовательность работ; текущие владельцы описаны в [TUI map](../../src/tui/README.md). Следующий [этап 04](04-local-llm-tools-os.md) specified, implementation не начата.

## Контекст и цель

TUI объединяет представления Ink, чистые reducer/state, ввод и orchestrators внешних операций. Сейчас части одной функции разбросаны между components/, каталогом функции и корнем tui/. Агенту приходится искать их по всей области; имя components само по себе не отличает общий примитив от представления конкретной функции.

Цель: для изменения функции её представления, состояние, ввод, orchestration и тесты находятся рядом, а общие операции принадлежат доменам и общие UI-примитивы не импортируют функции. Не менять поведение при перемещении файлов.

## Исходная отправная точка перед 03a

- В src/tui/mcp уже находятся mcp-actions, mcp-panel-state, mcp-reducer, mcp-key-bindings, mcp-orchestrator и два теста reducer/keys.
- Пять MCP-представлений находятся в src/tui/components: mcp-panel.tsx, mcp-list.tsx, mcp-detail.tsx, mcp-add-modal.tsx, mcp-remove-modal.tsx. Специализированных тестов этих компонентов и orchestrator сейчас нет; не считать проверку reducer доказательством корректной отрисовки и live connect.
- src/tui/persist-mcp-server.ts и его тест лежат в корне TUI. Общую операцию setMcpServerEnabled также использует src/http/route-mcp.ts; именно это ребро записано в import-exceptions.json. Оно должно исчезнуть первым срезом.
- Сборка функции проходит через debug-pane, TuiState/TuiAction, agent-event-reducer, tui-app, chat-orchestrator и callbacks в tui-command. Эти composition points остаются общими и меняют только адреса импортов.
- После этапа 02 общая геометрия списка и printable input независимы от функций. Generic pick-list принимает callbacks; providers/wizard-pick-list связывает их с владельцем мастера. Не переносить этот адаптер обратно в общий слой.
- Проверки работают: imports:check — ноль runtime SCC, одно точное исключение; typecheck:tests — 947 существующих диагностик, без MCP domain debt. Переносы не разрешают новую ошибку или ослабление проверок.

## Принципы организации

Сохранять текущие имена файлов, если имя правильно обозначает ответственность. Функция может быть плоской областью, пока это удобно; обязательных view/state/input каталогов или barrel на каждую папку нет. Общий UI-компонент получает данные и callbacks, но не импортирует функцию ради её handler. Представление конкретной функции может импортировать её handler для общей семантики клавиатуры и мыши.

Domain persistence не объединять с представлением только ради близости файлов. Проверенный пример — config/llm-provider-commands. Ресурсы MCP по-прежнему принадлежат McpManager и runtime; TUI orchestrator управляет своим refresh timer и проецирует состояние менеджера, но не становится владельцем транспорта.

Не вводить новый features/ уровень над существующими каталогами, общий utils/ и полный набор index.ts. Публичные именованные входы создавать только для фактических внешних потребителей; для первого переноса сохранять явные file imports, чтобы не вернуть runtime цикл.

## 03a. MCP — подробный первый срез

Состояние: verified. [Результаты](../testing/stage-03a-validation.md).

### Область и инварианты

Читать src/tui/AGENTS.md, src/mcp/AGENTS.md, src/config/AGENTS.md и src/http/AGENTS.md; соответствующие README и MCP client contract — по затрагиваемому поведению.

Разрешены механические перемещения пяти представлений, общего persistence и его теста, обновление импортов/комментариев, локальной навигации и точного исключения checker. MCP SDK, trust/resource classification, grammar, config defaults/migrations и runtime lifecycle не изменять. Исправления обнаруженного поведения или долга отделять от перемещения и отдельно объяснять.

Сохранить:

- JSON single-server/envelope validation, duplicate refusal, запись полного проверенного config и reset cache;
- порядок persistence → live connect/remove/toggle, сообщение о частичном успехе, когда файл уже записан, но live операция не удалась;
- anchored remove-confirm target, busy guards и подавление повторных операций;
- refresh timer, открытый detail и catalog projection, tools/resources/prompts tabs;
- list/detail navigation, modal precedence, add-modal editor fall-through, общую семантику mouse Enter и keyboard Enter;
- HTTP auth, status/error mapping и response shapes.

### 03a-1. Общие операции MCP config

Перенести src/tui/persist-mcp-server.ts в src/config/mcp-server-commands.ts и тест рядом. Внутри config импортировать конкретные модули вместо собственного index. Имена экспортов и bodies функций сохранить. Обновить TUI orchestrator и HTTP route, включая import/mock targets тестов. Не оставлять постоянный re-export из TUI.

В том же проверяемом изменении удалить точное HTTP → TUI исключение. imports:check должен показать ноль исключений и ноль циклов. Если перенос теста меняет существующий diagnostic fingerprint, отдельно подтвердить перенос того же кода/диагностики; не принимать новые ошибки или перезаписывать базу общим capture.

Проверки: перенесённый persistence test, src/http/route-mcp.test.ts, MCP keys/reducer, lint, typecheck:tests, imports:check. HTTP-маршрут после переноса не должен загружать TUI ни значением, ни типом.

### 03a-2. Представления рядом с функцией

Переместить пять components/mcp-*.tsx в src/tui/mcp/, сохранив имена. Исправить их относительные импорты и debug-pane entry. Состояние, actions, reducer, keys и orchestrator уже в целевой области — не переименовывать их попутно. Composition points получают только новые адреса импортов; глобальные state/action/callback shapes сохраняются.

Сравнить bodies через AST/токены без import paths и комментариев: перенос должен быть механическим. Найти все ссылки через rg, проверить README/docs/source comments. Старые пути удалить после обновления потребителей; не создавать сеть forwarding modules, скрывающих новый источник.

Проверки: MCP keys/reducer, debug-pane бюджет и затронутые app input tests, lint/type gate/import gate. Для новых важных UI проверок использовать fixtures по реальному контракту, не snapshot, повторяющий JSX.

### 03a-3. Закрыть пробелы проверки поведения

Перед переносом, если существующих seam-тестов недостаточно, добавить небольшой отдельный набор проверок:

- orchestrator: persisted/live partial success, отказ duplicate операции во время busy, start/shutdown refresh timer с fake timers;
- UI/input seam: opening detail, anchored remove confirmation и add-modal input fall-through, включая mouse активацию по тому же handler.

Для тестируемого orchestrator явно сузить локальный type-only runtime contract до используемых manager методов и refreshMcp, сохраняя совместимость AgentRuntime и не меняя алгоритмы. Использовать typed mock manager/process boundaries и временный state; не подключаться к реальному MCP-серверу или llama-server. Не копировать всё AgentRuntime в fixture и не ослаблять типы до any ради быстрого теста. Проверять наблюдаемое поведение; не тестировать сам факт нового пути файла, который уже проверяет imports:check.

Если найден отдельный lifecycle дефект, зафиксировать его и исправить отдельным изменением с воспроизводящим тестом; не скрывать в rename.

### 03a-4. Навигация и правила

Добавить src/tui/mcp/README.md с владельцами UI state/refresh timer/manager и реальными entry/checks; родительский tui/AGENTS.md достаточен, если новых ограничений нет. Обновить TUI/MCP/config/HTTP README и task route документации. Удалить упоминания components/mcp-* как текущих адресов.

Расширять архитектурную проверку только для подтверждённых shared primitives/feature composition boundaries. Не запрещать все feature-to-feature imports, если композиция необходима, и не добавлять исключения автоматически. Считать HTTP исключение погашенным после удаления файла TUI persistence и проверяемого отсутствия всех его потребителей.

### Приёмка среза MCP

Пять представлений и существующие UI state/input/tests находятся в tui/mcp; shared persistence находится в config. Все локальные/внешние потребители указывают на фактического владельца; forwarding paths отсутствуют. Поведение config/HTTP/live manager/input сохраняется и покрывается выбранными тестами. imports:check показывает ноль исключений и ноль runtime SCC; type debt не растёт. lint, typecheck:tests, docs:check, checker self-tests и нужные seam tests проходят; полный test:ci подтверждает интеграцию после переносов.

После приёмки записать результаты и уточнить следующий срез. Приёмка MCP сама по себе ещё не означает verified для всей организации TUI.

## Остальные срезы этапа 03

Состояние: все срезы verified; отдельные evidence сохраняют историю проверок. До каждого среза составить карту представлений/state/input/orchestrators/tests и точных внешних потребителей по фактическому графу после предыдущего изменения.

1. **Providers/LLM и composer — verified.** [План 03b](03b-provider-ui.md). Собрать специфичные views рядом с владельцами; сохранить общий provider config и generic list/input. Межфункциональные зависимости composer → LLM activation рассмотреть по контракту, без копирования переключения и preflight.
2. **Onboarding — verified.** [План 03c](03c-onboarding.md). Собрать шаги/меры/layout с state/input; сохранить reuse provider wizard и download orchestration. Оставить общие mouse/clipboard/theme примитивы независимыми.
3. **Local-models UI — verified.** [План 03d](03d-local-models-ui.md). Собрать каталоги, формы, progress и input рядом с UI state/orchestrator, без переносов внутреннего local-llm downloads/daemon/backend: это этап 04 общего маршрута.
4. **Остальные панели.** [Memory/tasks приняты, evidence 03e](../testing/stage-03e-validation.md); [skills/import приняты, evidence 03f](../testing/stage-03f-validation.md); [issue-report/uninstall приняты, evidence 03g](../testing/stage-03g-validation.md); [update UI — verified, evidence 03h](../testing/stage-03h-validation.md). Privacy/integrations/swarm уже имеют локальные views, без обязательного flattening. Прочие области — по подтверждённой карте; общие debug-pane/tab composition и chat shell остаются точками сборки.
5. **Итоговая граница shared UI.** Классифицировать оставшийся components/ по владельцам. В нём остаются реальные общие primitives/shell composition; новые feature views располагаются у функции. Проверка зависимостей фиксирует подтверждённую границу, не искусственную глубину каталогов.

Каждый срез получает уточнённый небольшой план и проверку поведения перед следующим. Следующий подробный срез уточнять после приёмки предыдущего по фактическим графу и долгу.

## Приёмка всего этапа и границы

Для каждой перемещённой функции README ведёт к её представлениям/state/input/orchestration/tests; shared UI не использует feature implementation ради общей операции. Все mechanical moves проверены отдельно от algorithm changes, нет новых runtime SCC или незарегистрированных архитектурных нарушений. Долг тестовых типов не увеличивается, baseline migration поясняется отдельно; основные input/layout/live-switch seams и полный CI-equivalent набор проходят.

Не менять структуру в packages/монорепозиторий, публичные команды, prompt literals, конфигурационные версии, runtime assembly и агентный цикл. .pr-review-56/ и EVIDENCE_ROUTER_MODEL.md остаются нетронутыми. После полной приёмки этапа 03 подготовить отдельный план 04 о local-llm и tools/os; не отмечать весь этап verified только за перенос MCP.

Оставшиеся функции и итоговая shared UI граница: [03i — verified](../testing/stage-03i-validation.md).
