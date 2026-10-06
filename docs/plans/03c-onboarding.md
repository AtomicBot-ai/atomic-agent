# Срез 03c: onboarding рядом с владельцем

Status: verified
Owner: repository maintainers

Часть [этапа 03](03-tui-organization.md). Создан после [приёмки 03b](../testing/stage-03b-validation.md), по фактическим импортам и базе 941 диагностик. Срез принят: [результаты проверки](../testing/stage-03c-validation.md). Следующий срез — [03d local-models UI](03d-local-models-ui.md).

## Контекст, цель и решение

Onboarding — поверхность первого запуска: выбор backend, скачивание/облачный мастер, внешний endpoint, предложение второго backend и импорт. State, reducer и keys уже в tui/onboarding, но screen/steps/measurement находятся в components, эффекты — в hooks, persistence — в корне tui. Чтобы изменить один переход, агенту приходится восстанавливать связи между тремя каталогами.

Цель: собрать специфичные представления, hooks, persistence и тесты в существующем tui/onboarding, сохранив порядок переходов, измерение терминала, отмену запросов и владение загрузкой. Разделить очистку fixtures, перенос views и перенос эффектов на отдельные проверяемые изменения. Не вводить features/view/state и обязательный barrel.

Persistence пишет именно tui.onboarding и сейчас используется только TUI; перенести его к onboarding. Общий provider config остаётся в config, а скачивание — у LocalModelsOrchestrator/local-llm. Не создавать общий domain command для UI timestamps без внешнего потребителя. Если такой потребитель появится при повторной проверке графа, пересмотреть это решение до переноса.

## Фактическая карта после 03b

### Представления: 18 source-модулей, 14 тестов

Из tui/components в tui/onboarding с прежними именами:

- onboarding-screen.tsx, onboarding-step-body.tsx, onboarding-surface-layout.ts, onboarding-header.tsx;
- onboarding-intro-step.tsx, onboarding-choose-step.tsx, onboarding-local-pick-step.tsx;
- onboarding-download-step.tsx, onboarding-download-progress.tsx, onboarding-download-ambient.tsx, onboarding-atom-field.tsx;
- onboarding-hf-flow.tsx, onboarding-hf-ref-step.tsx, onboarding-hf-pick-step.tsx;
- onboarding-url-step.tsx, onboarding-propose-step.tsx, onboarding-wait-or-jump-step.tsx, onboarding-import-step.tsx.

Все 14 components/onboarding-*.test.tsx перенести рядом: atom-field, download-ambient, download-frame, download-step, header, hf-flow, hf-steps, intro-step, local-pick-step, mouse, propose-step, screen, surface-layout, wait-or-jump-step. download-frame/hf-steps/mouse — seam suites, отсутствие одноимённого source не делает их общими компонентами.

Внешние production-потребители этой группы: tui-app → screen значением; hooks/use-onboarding-inputs и onboarding/onboarding-step-keys → OnboardingScreenCallbacks типом. Остальные зависимости между этими views внутренние. OnboardingStepBody и surface-layout уже используют providers/wizard и measurement по новым адресам 03b; владельца provider wizard не менять.

### Эффекты, persistence и тесты: ещё 9 файлов

Из tui/hooks в tui/onboarding: use-onboarding-inputs.ts, use-onboarding-lifecycle.ts, use-onboarding-url-actions.ts, use-onboarding-huggingface.ts, use-atom-field.ts, use-onboarding-lifecycle.test.tsx и use-onboarding-lifecycle-import.test.tsx. У этих пяти hooks текущие production-потребители только в onboarding views. Общий use-terminal-size и другие shared hooks остаются в hooks.

Из корня tui: persist-onboarding-state.ts и его test.ts. Значением его используют tui-command, screen, lifecycle и rerun-onboarding; tests также needs-onboarding/rerun. Обновить все адреса и комментарии, не изменяя read → merge → validate → write → reset cache и timestamps, задаваемые вызывающим кодом. Эти дополнительные тесты не имеют записанного долга.

Итого 24 production-модуля и 17 тестовых файлов в трёх малых группах переноса. local-backend-readiness остаётся общей TUI операцией: им пользуется также tui-command. Не копировать её проверки в onboarding.

## 03c-1. Исправить 14 диагностик до переноса

В перемещаемых view tests записаны 14 диагностик:

- 11 неиспользуемых React imports: atom-field, download-frame, hf-flow, hf-steps, intro-step, local-pick-step, mouse, propose-step, screen, surface-layout, wait-or-jump-step;
- screen: неиспользуемый ROOT_PADDING_LEFT;
- mouse: отсутствуют четыре обязательных TuiAppCallbacks;
- download-frame: modelId в составном pull fixture расширился до string вместо LocalModelId/EmbeddingModelId/_backend.

Удалить только неиспользуемые bindings; сохранить используемые named imports. Дополнить callbacks и дать составному state/pull fixture реальный контракт, сохранив modelId и проверки completed download/центровки. Не менять production типы, не добавлять cast/any, не удалять assertions. Проверить 14 suites и hooks/persistence tests; type gate должен показать только разрешённые resolved записи. Затем reduce: ожидаемая база 927, если устранены все 14 без новых ошибок. Другой результат исследовать, а не принимать через capture/rebase.

## 03c-2. Перенести представления

Прочитать tui/AGENTS и interface guide, config/llm/local-llm инструкции по сторонам интерфейсов; для импорта — import/README и лежащие под операциями domain инструкции. Повторить graph/rg inventory, сделать snapshots до fixtures и после них. Перенести 18 source и 14 test modules; обновить imports, mocks, literal dynamic imports, import-type references и актуальную документацию. Не оставлять forwarding modules.

Сохранить локальную композицию screen → body/layout/ambient, measurement рядом со строками, один общий helper статуса/числа строк wait-or-jump и вызов того же handler при мыши/клавиатуре. Тип OnboardingScreenCallbacks остаётся API screen в механическом срезе; его извлечение — отдельное решение при подтверждённой необходимости, не скрытая часть rename.

Проверить exact source bodies/AST без адресов модулей и комментариев, focused onboarding и потребителей, lint, type/import gate. Не менять алгоритмы fit/centering, progress, animation seed и терминальные бюджеты.

## 03c-3. Перенести эффекты и persistence

Перенести пять hooks, два lifecycle tests и persistence с тестом по карте. Hooks остаются hooks с текущей семантикой, без превращения их в новый orchestrator одновременно с rename. Timer/AbortController/refs остаются в том же коде с прежним start/cleanup и stale-response guard.

Проверить inputs/mouse, lifecycle/import, HF отмену и rerun/persistence через существующие suites. URL probe сохраняет текущий timeout/busy путь; у него нет отдельного AbortController/identity guard или dedicated suite — см. evidence. Если обнаружится недостаточно проверенный lifecycle или отдельный дефект, сначала воспроизвести отдельным meaningful test и рассмотреть исправление отдельно; не скрывать изменение логики в переносе. Не запускать настоящий download/server/provider ради unit checks.

## Инварианты и границы

- Screen владеет поверхностью первого запуска и footer; общие editor/mouse/theme/clipboard/terminal primitives не импортируют onboarding.
- Intro dismiss от клавиш/мыши/wheel/paste идёт общей семантикой; Ctrl+C hint и hook/input precedence сохраняются.
- Finished сначала решает second-backend offer, затем import offer, затем stamps completion/skip и закрывает поверхность. Once-only stamp/report guards и rerun suppression сохраняются; импорт не читает настоящий home в tests.
- HF lookup сохраняет AbortController, отмену/unmount cleanup, проверку id и reducer step guard; hook остаётся mounted до проверки render branch.
- Загрузка принадлежит local-models: jump-to-chat не отменяет pull, ошибки и retry отражают реальное состояние; ambient не выдаёт failed/completed загрузку за продолжающуюся работу. Двухфазные runtime/weights строки, центрирование и маленькие терминалы сохраняются.
- Provider wizard/verify/save/live apply остаются у providers/config/runtime. URL writes/probes и config-cache reset сохраняют текущий порядок.

Не переносить local-models views/internal downloads/daemon/backend, не менять prompt, config версии/defaults, публичные callbacks, runtime bootstrap, analytics события/пороговые значения или алгоритмы импорта. .pr-review-56/ и EVIDENCE_ROUTER_MODEL.md остаются нетронутыми.

## Приёмка и следующий срез

Все 41 файла находятся по подтверждённой карте без forwarding paths. Fixture fixes рассмотрены отдельно; source moves доказаны сравнением, база не выросла и перемещаемые tests чисты. Новый onboarding/README объясняет view/state/input/hooks/persistence, владельцев ресурсов и общие composition points; parent navigation обновлена без пустых AGENTS.

Focused onboarding/views/hooks/persistence, app input и provider seams проходят. lint, typecheck:tests, imports:check (ноль SCC/исключений), docs/self-tests и полный test:ci проходят; diff не меняет production bodies кроме import paths/comments. Записать evidence и отметить 03c verified только после проверки. После этого специфицировать local-models UI по фактическому дереву; весь этап 03 продолжает оставаться in-progress, план 04 ещё не создавать.
