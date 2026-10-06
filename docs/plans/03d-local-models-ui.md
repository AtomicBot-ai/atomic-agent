# Срез 03d: local-models UI и общие HF представления

Status: verified
Owner: repository maintainers

Часть [этапа 03](03-tui-organization.md), определена после [приёмки onboarding](../testing/stage-03c-validation.md). Срез принят: [результаты проверки](../testing/stage-03d-validation.md). Исходная база — 927, после fixes 922. Следующий срез — [03e memory/tasks](03e-memory-tasks-ui.md).

## Контекст, цель и решение

LocalModelsOrchestrator и UI state/input уже в tui/local-models, но панель, Hugging Face branch, notification prompt и download chip находятся в components. Onboarding и LLM panel используют часть этих views. Нужно сделать владельца представлений явным и сохранить один общий путь загрузки/активации.

Перенести семь source-модулей и два существующих теста в tui/local-models. HF reference editor и pick list — специализированные представления выбора модели, повторно используемые onboarding; разместить у local-models и сохранить callbacks без зависимости от конкретного state/key table. Не объявлять их generic domain-free primitives: pick list использует HuggingFaceRepoChoices и ramWarningFor из local-llm. Не копировать эти views в onboarding и не вводить общий utils/features слой.

Это организация TUI, а не внутреннего local-llm. Подпроцессы, каталоги, resumable downloads, backend и runtime ресурсы остаются на месте до этапа 04. Файлы перемещать отдельно от fixes fixtures и любых новых проверок поведения.

## Подтверждённая карта после 03c

Из tui/components в tui/local-models с прежними именами:

- local-models-panel.tsx: LocalModelsPanel/LocalModelDetail; внешние production-потребители DebugPane и LlmPanel;
- local-models-hf-branch.tsx: reference/pick branch; используется LocalModelsPanel и LlmPanel;
- hf-reference-editor.tsx: value/busy/error плюс callbacks, общий MultiLineEditor; используется HF branch и onboarding-hf-ref-step;
- hf-pick-list.tsx: callback-driven list, windowHfChoices/hfChoiceLine и measurement constants; используется HF branch и onboarding-hf-pick-step, включая измерение строк;
- notify-prompt-box.tsx: prompt/hint из LocalModelsNotifyPrompt; используется local panel и LlmPanelModals;
- download-chip.tsx: pull projection для одной строки StatusBar;
- local-llm-logs-panel.tsx: view state из local-models/local-llm-logs-state, используется DebugPane. Найден при полном инвентаре реализации; polling/reducer уже у этого владельца, поэтому добавлен как седьмой механический перенос.

Перенести notify-prompt-box.test.tsx и download-chip.test.tsx рядом. У panel/HF modules сейчас нет отдельных одноимённых component suites; manage-panel-fit, LLM panel/local keys/app, onboarding HF views/mouse и local-models orchestration tests — существующие потребители проверки. Отсутствие отдельного suite не скрывать за числом reducer tests.

Общие use-transfer-rate, MultiLineEditor, mouse/theme/row-window/render-progress-bar остаются у текущих владельцев. use-transfer-rate также используется onboarding progress и local-turn gate. Root persist-user-local-models-config и local-backend-readiness используются несколькими TUI flows/commands; не переносить их к одной view-функции ради симметрии. Guide должен явно назвать эти операции и доменные границы.

## 03d-1. Исправить пять диагностик перед переносом

В двух перемещаемых tests записано пять диагностик: два неиспользуемых React imports и три TS2322 в download-chip, где LONG_ID расширяется до string. LocalModelId допускает template literal custom-${string}; fixture формирует настоящий 87-символьный custom id, и его длина/отрисовка должны сохраниться.

Удалить неиспользуемые bindings, задать LONG_ID тип из реального контракта (например LocalModelId), сохранив выражение padEnd и все assertions. Не заменить длинный id коротким curated id и не менять production типы/casts/any ради зелёной проверки. Сначала оба suites и type gate, затем reduce. Ожидаемая база — 922, если ровно пять записей устранены без новых ошибок; ledger multiplicity count=3 проверить явно. Capture/rebase запрещён.

В нынешних local-models tests остаются ещё 24 диагностических случая. Их код не перемещается и исправление всего этого долга не входит в срез. Изменение импортных адресов не даёт права принимать новый fingerprint или ослаблять проверку.

## 03d-2. Проверить seams и выполнить переносы

Прочитать tui/AGENTS и guides, local-llm/config/llm инструкции по сторонам контрактов. Повторить graph/rg inventory, сохранить snapshot до fixtures и после них. Оценить существующие проверки для:

- panel list/detail и оконного row budget;
- HF reference editor/pick list: value/busy/error, clear, Escape, cursor и Enter/mouse callbacks соответствующего flow;
- notification hint и продолжения реального pull за modal;
- download chip: процент/ETA/offline form, backend label, длинные custom ids, shedding/drop по ширине StatusBar;
- LLM local activation/preflight и фоновой загрузки, продолжающейся после onboarding.

Использовать существующие suites. Если конкретный изменяемый seam не покрыт, добавить минимальную проверку наблюдаемого поведения отдельным изменением до переноса; не тестировать само наличие нового пути. Не запускать реальные серверы/downloads, не дублировать весь AgentRuntime и не добавлять type allowances для нового fixture.

Перенести сначала panel/HF branch/shared HF views, затем logs/notification/chip с двумя тестами; обновить callers, mock/import-type/literal dynamic targets и source comments. Сохранить API и bodies. Onboarding → local-models presentation — намеренная конкретная композиция; сами HF views не импортируют onboarding или его handlers. Общий editor не зависит от feature.

Сравнить каждый перенос и callers с snapshot по AST/исполняемым bodies без module paths/comments. Старые пути и forwarding отсутствуют. imports:check должен сохранить ноль SCC/исключений; не добавлять feature-to-feature ban или новый exception ради этих потребителей.

## Инварианты и границы

Сохранить keyboard/mouse handler route, modal precedence, cursor/filter/window state, notification-choice mapping и busy/abort guards. RAM warning остаётся предупреждением, а не запретом скачивания. mmproj строки/paired behavior, HF hidden choices и все width/window constants сохраняются.

Download chip остаётся проекцией worker/pull state, не запускает загрузку и не владеет её процессом. Rate hook и offline/ETA policy не меняются. Download/daemon ownership, resume/retry/cancel, activation rollback, paired GGUF/mmproj и shutdown порядок сохраняются у нынешних owners. Orchestrator алгоритмы, его 24 type diagnostics и domain lifecycle не исправлять попутно.

Не менять config defaults/версии, prompt, public callbacks, platform/backend selection, SDK/transport, runtime bootstrap, auto-update или hybrid-memory намерения. .pr-review-56/ и EVIDENCE_ROUTER_MODEL.md не трогать.

## Приёмка и следующий срез

Семь views и два tests рядом с local-models state/input/orchestration, все реальные потребители используют новые адреса. HF reuse остаётся callback-driven, shared primitives независимы. Новый local-models/README объясняет presentation/state/keys/orchestrator, реальные владельцы процессов и shared operations; родительская/LLM/onboarding navigation обновлена без пустых AGENTS.

Fixture fixes отдельно доказаны с сохранением assertions и multiplicity; mechanical source bodies неизменны. Focused local-models/LLM/onboarding, notify/chip/status-bar/manage-panel-fit и provider seams проходят. lint, test type gate, imports/docs gates/self-tests, git diff --check и полный test:ci проходят. Записать evidence, затем отметить 03d verified; реальное terminal/server/download ручное QA обозначить отдельно, если оно не выполнено.

После приёмки уточнить срез остальных панелей по фактическим владельцам и долгу. Этап 03 остаётся in-progress до проверки всех его срезов и итоговой shared UI границы; план 04 ещё не создавать.
