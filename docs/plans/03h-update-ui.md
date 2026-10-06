# Срез 03h: update UI и ввод предложения

Status: verified
Owner: repository maintainers

Часть [этапа 03](03-tui-organization.md), определена после [приёмки issue-report/uninstall](../testing/stage-03g-validation.md). Завершён; [приёмка](../testing/stage-03h-validation.md). Долг 904 → 902.

## Контекст и решение

Update UI показывает startup offer, постоянный status-bar banner, running indicator и restart prompt. Отдельного TUI update orchestrator/state каталога сейчас нет: версии/installer принадлежат src/update и ChatOrchestrator, UI-поля/actions/reducer — общей композиции, restart — tui-command. Четыре views лежат в components, небольшой private handleUpdateKey — в app-key-bindings.

Создать tui/update как владельца специализированного представления и локального offer input. Не создавать второй updater, отдельную копию state или общий modal framework. Общие точки сборки сохраняются, а guide явно ведёт к ним. ThemePicker пока не включать: его live preview/revert/submit и общие palette helpers требуют отдельной карты. Observe/chat-shell также уточнять отдельно.

## Фактическая карта после 03g

Из components в tui/update: update-banner.tsx, update-banner.test.tsx, update-modal.tsx, update-indicator.tsx и update-restart-prompt.tsx. Всего пять moves: четыре production views и один test. TuiApp потребляет modal/indicator/restart; StatusBar — banner и planUpdateBanner. status-bar-update.test.tsx остаётся рядом с StatusBar как composition test.

handleUpdateKey принимает input/key/AppKeyContext и возвращает boolean: Ctrl/Meta не потребляет, y вызывает onUpdateConfirmed, n/Escape dispatches update_dismissed, прочее проходит дальше. Глобальный router вызывает его только при updatePrompt. Отдельный updateStatus=done branch вызывает onUpdateRestart и quit_requested; он остаётся в глобальном router на прежнем месте после approval routing.

CheckForUpdate/runUpdate находятся в chat-orchestrator: checkOnStartup/canSelfUpdate gates, silent check failure, refusal при foreground/background turn, streaming installer output и finished/error actions. Domain check-app-update/run-app-update реализуют проверку и установку; tui-command связывает callbacks и post-exit restart/fake-update simulation. Их тела не извлекать одновременно с UI.

## 03h-1. Fixtures и достоверное покрытие offer seam

В update-banner.test.tsx и status-bar-update.test.tsx есть по одной TS6133 на unused React. Удалить только эти импорты, сохранить assertions, widths, phase fixtures и весь тестовый код. Выполнить обе suites и type gate; reduce должен удалить ровно два случая, 904 → 902, без новых allowances/options. Capture/rebase запрещён.

Banner/StatusBar tests проверяют phases, budget/degradation, dismiss persistence и failed retry presentation. Agent-event-reducer имеет update cases. Прямого dedicated update key suite inventory пока не нашёл; перед extraction повторить поиск и, если seam не покрыт, добавить небольшой typed suite через handleAppKey, проверяющий offer y/n/Escape, Ctrl/Meta/прочие fall-through и приоритет относительно approval/done restart. Тест должен различать поведение, а не только новый путь. callbacks подменены, реальный installer/restart не запускается. Использовать полный AppKeyContext contract и fakeSession, не any/casts и не неполные fixtures. Наличие нового suite намеренно меняет counts; записать фактический результат, не сохранять старое число тестов искусственно.

## 03h-2. Переносы и извлечение

Прочитать tui/AGENTS/interface, domain update/README и runtime instructions; config — по фактически затрагиваемым settings seams. Повторить все consumers/mocks/literal dynamic/type-import targets. Сохранить snapshots до fixture cleanup, перед moves и перед extraction, debt и protected/package hashes.

Перенести пять файлов, обновить consumers; no forwarding/barrels. Exact source comparison допускает только module substitutions. Затем отдельно извлечь неизменное тело handleUpdateKey в update/update-key-bindings.ts, с намеренным named export и type-only context, ограниченным dispatch/callbacks. handleAppKey вызывает его в прежнем месте; done/restart branch и public AppKeyContext/AppKeyCallbacks неизменны. Проверить AST тела/return semantics и все остальные router declarations отдельно от импорта/export/context alias. Не расширять этот helper до installer lifecycle.

Создать update/README: четыре views, local offer input, global state/actions/reducer, ChatOrchestrator/domain operations и tui-command restart. Обновить parent/interface/dependency navigation. Общие useSpinner/mouse/theme/width и download chip остаются у владельцев.

## Инварианты и приёмка

Dismiss скрывает offer, но сохраняет известную версию/banner. Running/done/failed phases и retry presentation прежние. Banner budget продолжает делить одну строку с DownloadChip; его click вызывает тот же onUpdateConfirmed, что y, с существующей modal mouse layer. Не переводить banner в отдельный updater или менять layout algorithm.

Refusal при активных foreground/detached turns, startup gates, installer execution/failure, post-exit restart и fake-update path сохраняются. Никаких реальных updates/installer downloads/re-exec во время проверки. Prompt literals, config defaults/версии, runtime assembly, CLI/API и protected .pr-review-56/ и EVIDENCE_ROUTER_MODEL.md неизменны.

Existing banner/status-bar, agent-event-reducer, app/keys и domain update suites плюс найденный/добавленный offer seam проходят; отмечать отсутствие individual modal/indicator/restart component suites и ручного terminal QA. Lint, type gate (ожидаемо 902), checker self-tests, imports:check (ноль SCC/исключений), docs:check, quarantine registry и git diff --check проходят. Новые input/test modules увеличивают inventory намеренно; не добавляют diagnostic allowances. Full test:ci проходит с нужными loopback fixtures. Пять moves, unchanged extracted body, assertions cleanup и hashes доказаны отдельно.

После evidence отметить 03h verified и уточнить следующую область theme/observation/chat-shell и маршруты уже локальных privacy/integrations/swarm. До итоговой shared UI классификации весь этап 03 остаётся in-progress; план 04 не создавать.
