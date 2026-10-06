# Срез 03g: окна и ввод issue-report/uninstall

Status: verified
Owner: repository maintainers

Часть [этапа 03](03-tui-organization.md), определена после [приёмки skills/import](../testing/stage-03f-validation.md). [Приёмка 03g](../testing/stage-03g-validation.md) завершена: три moves, два handlers у владельцев с неизменными телами/precedence, полный набор проходит; долг остался 904. Следующий [срез 03h](03h-update-ui.md) specified; весь этап 03 ещё in-progress.

## Контекст, цель и выбор

Issue-report собирает выбранную оператором диагностику, создаёт локальный ZIP, показывает disclosure и отправляет подтверждённый отчёт в GitHub. Uninstall показывает план удаления, требует отдельное слово подтверждения и передаёт выполнение после закрытия UI/runtime. Их state/reducer/orchestration уже имеют владельцев, но два окна лежат в общих components, а два частных обработчика ввода — внутри app-key-bindings.

Собрать окна и локальный ввод у владельцев, сохранив глобальную точку определения precedence. Выбраны две малые области с проверенными seams. Privacy/integrations/swarm уже имеют представления в своих feature/components и не требуют переезда ради одинаковой глубины каталога; их навигацию и оставшиеся границы оценить отдельно. Не перестраивать весь app-key-bindings или все модальные окна сразу.

## Фактическая карта после 03f

- components/issue-report-popup.tsx → issue-report/issue-report-popup.tsx. Его четыре component tests уже в issue-report и меняют только импорт. Production consumer — TuiApp.
- components/uninstall-modal.tsx и uninstall-modal.test.tsx → uninstall/. Production consumer — TuiApp. Тест сейчас проверяет восемь сценариев bodyLines/copy, не полноценные Ink clicks.
- В app-key-bindings.ts находятся private handleIssueReportKey и handleUninstallKey. Их проверки уже лежат в issue-report/issue-report-keys.test.ts и uninstall/uninstall-keys.test.ts и входят через handleAppKey. Это seam для сохранения порядка маршрутизации, а не повод переключить тесты только на новый direct helper.
- Issue-report имеет state, levels, redaction/trace-redaction, body/build/zip и orchestrator/tests. Uninstall имеет state/actions/reducer/orchestrator и reducer/key suites; deletion domain находится в src/uninstall.
- Фактический inventory также нашёл tui/uninstall-modal-focus.test.tsx: два Ink/TuiApp теста блокировки ввода за modal и Escape. Он остаётся рядом с TuiApp как проверка общей композиции; его существующий session-fixture debt вне этого среза.

Перемещаемые тесты не имеют recorded debt. В уже существующих issue-report/uninstall tests остаётся 11 случаев: семь assertions/casts orchestrator и четыре uninstall key fixture. Они не перемещаются и не входят в этот срез; ledger не расширять и не выполнять capture/rebase. Если фактическая проверка выявит новую ошибку, объяснить и исправить отдельно.

## Последовательность

1. Прочитать tui/AGENTS/interface, issue-report/README, domain uninstall и error-reporting guides, runtime instructions; config/credentials — по фактически затрагиваемым seams. Повторить inventory consumers/mocks/type/dynamic imports и сохранить исходный snapshot, protected hashes и debt.
2. Отдельно перенести два окна и один test module, исправив все module targets. Сохранить exported names/bodyLines API, layout literals, callbacks и весь исполняемый код. Не вводить forwarding/barrels. Три перемещения и callers сравнить после точных substitutions; assertions перенесённого теста сохраняются.
3. Отдельно извлечь тела private handleIssueReportKey и handleUninstallKey в issue-report/issue-report-key-bindings.ts и uninstall/uninstall-key-bindings.ts. app-key-bindings импортирует именованные handlers и вызывает их в тех же местах; handleAppKey/AppKeyContext/AppKeyCallbacks остаются прежними публичными контрактами. Сохранить сами тела, аргументы, return semantics и комментарии инвариантов.
4. Для handlers дать только требуемый state/dispatch/callback context, например type-only Pick<AppKeyContext, "state" | "dispatch" | "callbacks">; concrete runtime/config/resources им не нужны. Type-only обратное ребро к общему contract не превращать в value import или self-barrel. Тесты продолжают проверять handleAppKey precedence. Сравнить AST тел извлечённых функций и все остальные bodies с snapshot; новые exports/imports и типизированный локальный seam записать отдельно от механического переноса. Если понадобятся изменения логики, не скрывать их под extraction.
5. Дополнить issue-report/README и создать uninstall/README с routes view/state/input/orchestrator/tests, владельцами ресурсов и фактическими ограничениями. Обновить parent/interface/dependency navigation. Не создавать новый общий modal framework или utils.

## Обязательные инварианты

Issue-report: уровни раскрытия и redaction, ZIP до подтверждения, показ имени/размера/назначения, token refusal, anchored prepared report, close/build stale-result policy, sending guard и ошибочные/успешные статусы сохраняются. Не отправлять настоящий отчёт для проверки и не добавлять более широкий сбор логов. Orchestrator/domain helpers остаются единственным путём упаковки и внешней отправки; view/input лишь отображают или вызывают callbacks.

Uninstall: review начинается на Cancel; Continue требует непустой план; последнее подтверждение — отдельно набранное слово, без prefill/autocomplete, с текущим trim/case policy и cap ввода. Ctrl+C contract, Escape, закрытие при пустом плане, ignoring late result, closing guard и порядок callback → quit_requested сохраняются. Реальное удаление запускается только после unmount/runtime shutdown в прежнем tui-command пути. Preview измеряет domain plan; view не начинает deletion. Проверки используют временные fixtures, не state оператора или установленный binary.

Глобальная modal/editor/menu precedence, shared mouse/theme/fitToWidth и публичные callbacks сохраняются. Config defaults/версии, prompt, API frontends, runtime bootstrap/lifecycle и deletion/report algorithms не менять. .pr-review-56/ и EVIDENCE_ROUTER_MODEL.md защищены.

## Проверки и приёмка

Existing issue-report/uninstall suites, popup/bodyLines, app keys/selection/TuiApp/uninstall-modal-focus и подходящие domain deletion/redaction seams проходят. Удержать проверку через handleAppKey, чтобы extraction не обходила global precedence. Не заменять source-specific assertions, не добавлять tests только на новый путь. Два существующих Ink/TuiApp focus tests покрывают отдельные keyboard seams; dedicated uninstall mouse suite и полное post-exit lifecycle coverage отсутствуют. Отсутствие ручной проверки и реальной отправки/удаления обозначить явно.

Lint, type gate (904 без новых allowances), checker self-tests, imports:check (ноль SCC/исключений), docs:check, quarantine registry и git diff --check проходят. Новые два input-модуля намеренно увеличивают production/root inventory; это не новый diagnostic debt. Полный test:ci проходит с необходимыми локальными listeners. Проверить три mechanical moves и неизменность двух извлечённых function bodies отдельно, сохранить review hashes и evidence.

После evidence отметить 03g verified и уточнить следующую область update/theme/observation/chat-shell по оставшемуся реальному дереву. Этап 03 остаётся in-progress до итоговой классификации shared UI и общего доказательства; план 04 пока не создавать.
