# Срез 03f: представления skills/import

Status: verified
Owner: repository maintainers

Часть [этапа 03](03-tui-organization.md), определена после [приёмки memory/tasks](../testing/stage-03e-validation.md). [Приёмка 03f](../testing/stage-03f-validation.md) завершена: восемь views и два tests у владельцев, два fixture cases устранены (906 → 904), полный набор проходит. Следующий [срез 03g](03g-issue-uninstall-ui.md) specified; весь этап 03 ещё in-progress.

## Контекст, цель и выбор

Skills UI показывает установленные/отключённые навыки, каталог двух источников, карточку и подтверждения установки/удаления. Import UI собирает параметры переноса данных других агентов и показывает preview/report. State/input/orchestrators уже находятся у функций, но восемь представлений и два import component suites остались в components.

Собрать эти две небольшие области у владельцев отдельными механическими группами. Сначала очистить ровно две ошибки перемещаемого mouse fixture; оставшиеся 47 случаев в существующих skills/import tests сохранить явно, без массовой очистки и расширения этой задачи. Не извлекать операции установки/импорта или менять их алгоритмы одновременно с переносом.

## Фактическая карта после 03e

### Skills

Из components в tui/skills: skills-panel.tsx, skills-list.tsx, skills-detail.tsx, skills-hub-list.tsx, skills-hub-card.tsx, skills-install-confirm.tsx и skills-remove-confirm.tsx. Единственный внешний production consumer этих views — DebugPane → SkillsPanel. Уже рядом: state/actions/reducer/keys/filter/summary/format-downloads/orchestrator и четыре suites keys/filter/reducer/summary. Dedicated component/orchestrator suites отсутствуют.

SkillsOrchestrator остаётся владельцем refresh timer, GitHub catalog cache, ClawHub client и map staged installs. shutdown очищает timer и запускает discard для ожидающих установки; не утверждать, что перенос даёт новую отмену всех сетевых запросов или ожидание полного cleanup. Registry/files и scan/stage/commit/discard принадлежат skills domain. UI сохраняет отключение без удаления, anchored remove/install targets, scan verdict/findings, preview body/error и частичные ошибки каталогов. Clean scan сейчас коммитится сразу, прочие verdicts требуют существующего подтверждения — эту политику не менять.

### Import

Из components в tui/import: import-panel.tsx, import-panel.test.tsx и import-panel-mouse.test.tsx. Внешний production consumer — DebugPane → ImportPanel. Уже рядом: state/actions/reducer/keys/import-mouse/form-options/sources/build-importer/orchestrator и шесть pure/input/orchestrator suites.

Сохранить source-dependent options и focus, running/busy guards, preview/execute/report, overwrite/limit, unreadable-store warning и одинаковую семантику кликов/клавиш. Существующие suites используют настоящий MouseProvider/registry и проверяют действия по координатам Ink frame; не заменять их проверками путей.

ImportOrchestrator также используется onboarding: общий buildImportRunner собирает source-specific domain importers. Runtime owns destination stores; только локальный per-run source закрывается runner.close в существующих finally. Конструкцию runner и обработку ошибок не перестраивать в этом срезе и не заявлять новое покрытие ошибок до создания runner. Onboarding остаётся write path без overwrite, tab сохраняет свой preview. Строка AGENTS.md означает внешний вход Codex importer — не переименовывать её как справочник репозитория. Domain import/storage/config/secret conversion не переносить в TUI.

## 03f-1. Исправить две ошибки перемещаемого fixture

В import-panel-mouse.test.tsx есть TS2739 на callbacks (нет onApprovalDecision/onAbort/onQuit/onMessageSubmitted) и TS6133 на неиспользуемый React import. Удалить unused import и дополнить реальный TuiAppCallbacks четырьмя no-op callbacks, сохранив существующие preview/execute collectors. Все actions, click coordinates, reports и assertions сохранить.

Запустить два component suites и type gate до перемещения; reduce должен удалить ровно два случая, 906 → 904, без новых fingerprints/allowances и изменения compiler options. Не использовать any/casts/Partial для обхода contract, capture/rebase и отключение checks. import-panel.test.tsx сейчас не имеет recorded debt; 47 случаев в уже существующих feature tests не перемещаются и не разрешаются заново.

## 03f-2. Перенести две группы и обновить навигацию

Прочитать tui/AGENTS и interface guide, skills/AGENTS, import/README и инструкции runtime/config; session/memory/tasks и prompt — по затрагиваемым операциям. Повторить inventory всех consumers, включая mocks/literal dynamic imports/import types. Сохранить snapshots до fixtures и перед каждой группой.

Перенести семь skills views, затем import view и два tests. Исправить локальные импорты и consumers без forwarding/barrels. Сохранить exported names, bodies и callback/action contracts. Каждую группу сравнить с snapshot после разрешённых module-literal substitutions; итоговое сравнение всех TS/TSX и assertions отделить от fixture fix.

Создать tui/skills/README и tui/import/README: composition, state/input, реальные resource owners, условия чтения domain guides и команды. Обновить parent/interface/dependency navigation. Не создавать пустые AGENTS или общий utils; не вводить новые обязательные levels или packages.

## Проверки и приёмка

Выбранные existing skills/import suites, import component/mouse, onboarding import seams, app keys/TuiApp и DebugPane budgeting проходят. Сверить фактическое покрытие enabled/disabled, hub/card/search/scroll, install/remove modal precedence и source-dependent preview/apply; отсутствующие dedicated suites и ручное QA явно записать. Не добавлять тесты только на факт перемещения файлов.

Lint, type gate (ожидаемо 904), type/import/doc checker self-tests, imports:check (ноль SCC/исключений), docs:check, quarantine registry, git diff --check и полный test:ci проходят. При реальной новой ошибке разобрать причину отдельно, не расширять ledger. Механическое сравнение подтверждает десять moves и отсутствие unrelated code changes; защищённые review файлы сохраняют hashes.

Алгоритмы domain import/install/security, runtime assembly/lifecycle, config defaults/версии, prompt literals и public APIs остаются прежними. Исправления поведения — отдельное обоснованное изменение после переноса, если они потребуются. Реальные персональные источники, live registry install/delete и secret migration для проверки не использовать.

После evidence отметить 03f verified и специфицировать следующий малый набор оставшихся channels/swarm/integrations/прочих views по фактической карте. Весь этап 03 остаётся in-progress до окончательной классификации components/shared UI. План 04 пока не создавать.
