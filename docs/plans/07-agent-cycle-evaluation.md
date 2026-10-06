# Этап 07: цикл агента и итоговая оценка реорганизации

Status: verified
Owner: src/agent/ and repository maintainers

Создан после [verified06](../testing/stage-06-validation.md). Исходная проверка:1074 suites/12889 passed/4 existing skips, debt848/no newerrors, imports0 cycles/exceptions. Implementation07 завершена: fresh immutable source snapshot, exact extraction/public proofs, seam tests, финальный CI и все14 matched runs сохранены в [приёмке07](../testing/stage-07-validation.md). Successful tasks6/7 в обоих variants; observer source output уменьшился в этой case study, общего speed/quality claim нет.

## 1. Контекст, цель и конечная граница

AgentLoop управляет ходом одного пользовательского turn: подготавливает память и модель, запускает шаги, принимает решения о повторе и завершает turn. executeStep строит запрос модели, разбирает ответ, проверяет вызовы, исполняет batch и фиксирует результаты в SessionState. Сейчас эти обязанности смешаны в двух больших файлах; изменение recovery или commit требует читать соседние политики и wire details, которыми эта задача не владеет.

Цель — дать исполнению turn, обработке ответа модели, допуску вызовов, фиксации состояния и контролю прогресса явных владельцев, сохранив shipped behavior и проверив результат на одном фиксированном наборе задач разработки.

Это один конечный этап. Внутренние волны реализации и небольшие reviewable изменения описаны здесь; новые алфавитные микропланы после каждой пары перенесённых функций не нужны. После принятия 07 общий маршрут завершён: дальнейшие behavioral improvements заводятся отдельными задачами, а не продлевают реорганизацию бесконечно.

В scope: src/agent/, совместимые type-only imports его потребителей, соответствующие правила imports, документы и проверяемые seam tests. Вне scope: изменение модели/промптов/grammar, thresholds/budgets/defaults, новые политики, алгоритмы инструментов и памяти, исправление старых ошибок во время механического переноса, monorepo/packages. Ограничения .pr-review-56/ и EVIDENCE_ROUTER_MODEL.md остаются прежними.

Сохранённый итог 06 становится исходной точкой реализации: новый immutable snapshot, полный inventory imports/exports, baseline проверок, source hashes и текущая задолженность типов. Snapshot pre-07 достаточен для эквивалентности этого этапа; он не доказывает эффект всей программы против исходного проекта.

## 2. Проверенные исходные факты и реальные seams

Read-only исследование выполнено по текущему дереву 2026-10-06; после принятия 06 размеры и imports переснять:

- agent-loop.ts — 3193 строки; публичный AgentLoop, большой runTurnInner, dependency/event/result contracts, turn memory/lesson/reflection preparation and finalization, steering, recovery и progress bookkeeping.
- step-executor.ts — 3873 строки; contracts, executeStep/executeStepInner, runInitialCompletion, consumeStream, wire/parser/reasoning helpers, validateBatch и trim/wave helpers, repair request, dispatch и appendBatchedTurns/applyStateEffects.
- batch-executor.ts — 1037 строк; planBatch/executeBatch, синхронные gates и отказ до dispatch. Эти gates меняют состояние tracker до запуска sibling calls.
- loop-detector.ts — 1522 строки; ToolLoopTracker владеет history, warning buckets, pending tests, read coverage, outcome counters и ProbeRuns; рядом лежат hashing/fingerprints и текст уведомлений.
- Отдельные recovery helpers уже существуют: parse-failure-recovery, empty-completion-recovery, size-rejection-recovery, truncation-recovery. Отдельные policy/progress helpers уже существуют: claim/link evidence, plan/fusion mode, review-stall, read-coverage, wandering-spread, test-command-key, workspace-fingerprint и progress-note-reply. Создавать второй источник тех же алгоритмов не требуется.
- src/agent/index.ts уже содержит большой публичный named-export API. Кроме barrel imports, runtime, tracing, memory, channels, HTTP, tasks, tools/fusion, TUI и sidecar используют прямые imports agent-loop/step-executor/loop-detector. Среди runtime consumers есть именно fingerprintToolOutcome в tools/fusion/worker-result.ts, а не только типы.
- runInitialCompletion — один основной запрос шага; при неудачном parse/validation существующий executeStep делает bounded unary repair. Поэтому invariant «one inference per step» нельзя интерпретировать как запрет уже существующего repair/recovery либо как обещание ровно одного HTTP-запроса. Основной inference не дробится ради каждого инструмента; repair и turn retries сохраняют существующие бюджеты и observability.
- consumeStream lazily создаёт parser после определения servedTransport, различает reasoning channels и закрывает недочитанный iterator в finally. Repair проходит unary, чтобы не повторить уже отданные streamed deltas.
- Turn finalization включает lesson lifecycle и fire-and-forget reflection с allowlist union за весь turn. Cancellation и ephemeral workers не получают обычные success/failure memory effects. Эти границы не сводятся к общему finally без проверки.

Source of truth: [agent instructions](../../src/agent/AGENTS.md), [guide](../../src/agent/README.md), [batching](../../src/agent/docs/batching.md), [recovery](../../src/agent/docs/recovery.md) и существующие tests. Archive/proposals не добавляют новые ограничения.

## 3. Целевое владение кодом

Рекомендуемая организация — turn/, step/, dispatch/, progress/, policies/ внутри agent. Это группы механизмов, а не обязательная глубина дерева. Новые filenames descriptive kebab-case, tests рядом с owner. Не нужны index.ts в каждой группе. Точный список закрытых recipes и их typed arguments фиксируется перед переносом по свежему source inventory; перечисленные ниже файлы задают границы ответственности, а не разрешают новый произвольный dependency bag.

### Публичный контракт

agent-contract.ts владеет AgentLoopDependencies, RunTurnOptions/Result, AgentLoopEvent/Reason и публичными memory/steering/lesson seams. step/step-contract.ts владеет LlmStreamParams/CompleteStream, StepDependencies/Context/Outcome/Terminal и связанными contracts; существующий step-events.ts сохраняется самостоятельным владельцем event shape либо переносится вместе с совместимым reexport. Никакой contract не импортирует concrete loop/executor или composition root.

Публичные agent-loop.ts, step-executor.ts, batch-executor.ts, loop-detector.ts и index.ts сохраняют прежние доступные exports, signatures, optional properties, error class identity и reexports на время совместимости. Class BatchValidationError должен иметь один owner и одну constructor identity. Новые consumers переходят на явный contract или конкретный owner; runtime wiring не импортирует giant implementation только ради типа. Сужение означает меньше новых exports/реальных зависимостей, а не скрытое удаление старого API. Deprecated facade removal — отдельное решение после inventory потребителей, не условие этого этапа.

### Исполнение шага

- step-inference.ts: построение LLM request envelope/grammar variants, основной completion, stream consumption и reasoning alignment. Сам prompt builder остаётся в prompt/, stream parser и transport в llm/; переносится orchestration, не их алгоритмы. Slot acquisition/release сохраняются на прежних try/finally boundaries.
- step-parsing.ts: served-transport-sensitive parse, native/tool JSON compatibility, validation failure shaping и bounded unary repair. Lazy grammarPrompt и messages tail должны оставаться repair-shaped; getter/callback timing не превращать в eagerly captured значения.
- step-batch-policy.ts: validateBatch, terminal/schema validation, approval trim, pure-read wave split, progress-note extraction и held terminal/evidence shaping в прежнем порядке. Plan/fusion/read/input/approval enforcement остаётся фактическим dispatch gate; разрешение в prompt не обходит registry.
- step-commit.ts: materialization результатов по batch index, cancelled placeholders, rare autoload, transcript turns, latest result/world/loaded skills/tools effects, terminal classification и progress-note record. Один явный commit path; append/record/event order не менять. Не выделять «pure reducer», если текущий код делает config reads/events: эти зависимости передаются явно и вызываются на прежних местах.
- executeStep остаётся видимым orchestrator этих фаз. State commit начинается только после outcomes; parsing/repair не выполняют инструменты и не фиксируют частичный tool state.

### Turn, recovery и завершение

- turn-preparation.ts: pinned/live LLM slice, initial local refresh рядом с recall, turn role/policy state, recalled allowlist accumulators и ограниченные budgets. У каждого mutable объекта один turn owner; instance-wide ProfileClipWarnings остаётся instance-wide, не сбрасывается на каждый turn.
- turn-recovery.ts: текущая классификация error/cancel/timeout/credit/size/truncation/empty/parse/outage и решения retry/park/fail/stop. Existing helper modules — единственные владельцы правил. Решение принимает exact typed inputs и возвращает narrow action/state update; порядок catch arms и граничные callbacks сохраняются. Это не новая универсальная retry machine.
- turn-finalization.ts: существующие terminal statuses/events/turnCount/lastError, lesson outcomes, reflection segmentation и allowlists, formatTaskStoppedReply. Синхронная фиксация и fire-and-forget effects остаются различимыми. Steering closeAndDrain должен быть одним атомарным вызовом на всех exits, включая throw path; не переносить его раньше последних events.
- AgentLoop.runTurn и центральный step loop сохраняют orchestration: live refresh/steering → request budget → executeStep → progress/recovery decision → finalization. Не прятать этот порядок в generic middleware pipeline.

### Dispatch и прогресс

dispatch/batch-gates.ts получает закрытые refusal/final/plan/fusion/sync-loop gate recipes из batch-executor; сам scheduler остаётся владельцем fanout/serial/terminal barrier и batch-index outcomes. Gates выполняются синхронно в emitted order; check → recordCall sibling visibility сохранено. Refusal/evidence/loaded-skill results не переименовывать и не сжимать иначе.

progress/loop-fingerprints.ts и loop-notices.ts отделяют deterministic normalization/hashing и тексты от tracker state. ToolLoopTracker сохраняет единый owner всех связанных history/maps/ProbeRuns: дробление каждого counter в service-object без самостоятельной ответственности отвергнуто. Existing read/wander/test helpers группируются рядом с tracker вместе с tests отдельным чистым переносом, а не переписываются.

Existing plan/fusion/claim/link/step-tool-set helpers располагаются в policies/; progress-note reply относится к step commit; recovery leaves — к turn recovery. Для каждого переноса старый import/reexport compatibility и docs route обновляются явно. Простая раскладка helper files и извлечение сложного recipe — отдельные reviewable изменения, чтобы видеть источник semantic drift.

## 4. Порядок реализации и параллельность

1. После verified06 сохранить этот подробный план, baseline snapshot/manifest и fixed evaluation task briefs. Снять imports/exports, data/control flow phases, live getter timing и checks. Уточнить recipe API до больших writes; составить ownership map public types/events/errors.
2. Первый согласованный проход: независимые leaves A step contracts/inference/parsing, B dispatch gates/progress pure helpers, C turn contracts/preparation/finalization. Integrator единолично правит old facades, центральные orchestrators, общий barrel, consumer imports и shared proofs. Изолированные write sets и immutable snapshot обязательны; соглашение об API предшествует edits. Если recipe делит один body с другой задачей, такие изменения последовательны.
3. Второй проход внутри этого же этапа: step batch policy/commit и turn recovery/loop orchestration после проверки APIs первого прохода. Existing helper relocation отделяется от сложной extraction. Нельзя одновременно менять один исходный orchestrator несколькими агентами.
4. Интеграция: обновить routes/README/mechanism docs и dependency boundaries. Contract→implementation cycles запрещены, policies/progress не импортируют runtime bootstrap/frontends. Проверить intentional API inventory. Scope exceptions к imports checker не добавлять ради нового цикла.
5. Один итоговый acceptance run после coherent integration; затем одинаковый task panel и self-contained report. Не запускать полный CI каждым leaf или скрывать промежуточные failures под финальным summary.

## 5. Поведенческая эквивалентность и meaningful проверки

Для закрытых переносов source proof восстанавливает старые declarations, literals/comments/errors и call order modulo документированных dependency identifier/argument substitutions. Для split closure state нужен отдельный semantic seam test: source proof сам по себе не доказывает сохранность lazy reads, mutable refs или finally. Оставшиеся non-owned production algorithms/config/prompt/grammar/schema/tool code должны совпасть с baseline, кроме согласованных import/comment изменений.

Существующая база: src/agent/*tests, включая profile-matrix, native-tool-call-execution-integrity, parallel-tool-calls.integration, batch executor/resource-class/loop-detector, reply attachments/progress-note, все recovery/evidence/progress helpers, turn cancellation/deadline/stop cause/steering/local gate/fusion/lesson/allowlists/reflection/segmentation. Reuse существующих typed fixtures; обновлять claims fixtures только до реального полного contract, не casts/unknown/allowances.

Новые seam tests там, где граница действительно изменилась:

- Main stream → unary repair: committed deltas не повторяются; repair prompt/messages/lazy grammar variant одинаково корректны; servedTransport первого chunk определяет parser; abandoned iterator return вызывается и secondary cleanup error не заменяет original error.
- Invalid parse/empty/size/truncation/transport/credit/cancel/tool failure получают прежние разные budget/counter/status/event paths. Aborted stream race с «fetch failed»/parse error не становится retry. Необъявленный retry на последнем допустимом шаге не появляется.
- Early gate перед invocation: corrupted/unknown args, final/tool-set, plan/fusion, synchronous loop check/record order. Duplicate siblings видят предыдущую запись. Terminal tail ждёт work; ordinary tool error не отменяет siblings; cancel прекращает ещё не начатые serial calls.
- State commit по batch index при инвертированном completion order: tool/result alignment, latest world/skills/tools winner, cancelled placeholder, suppressed reply evidence, progress note без closure, reply ends turn/finish ends session.
- Live steering/model/config callbacks между steps, reserved summary stable-prefix invariants, unchanged slot owner/cleanup; two turns не делят evidence/notice/retry state. Instance clip warning state сохраняется across turns как сейчас.
- Terminal lesson/reflection effects: success/failure/cancel/credit/ephemeral distinctions, surfaced allowlist union через весь turn, segmentation cadence/final flush, caught fire-and-forget errors, no stale steering after exit.
- Tracker после вынесения helpers: volatile outcome normalization, write reset/read coverage/test fingerprints/wandering ladder и warning bucket semantics в прежнем порядке; formatting bytes сохраняются.

Для differential scenarios фиксировать clocks/ids/scripted completions/error injections и сравнивать SessionState, observable event sequence, dispatch log, request count/shape и outcomes старого/new owner. Нестабильные durations нормализовать явно. Это regression/equivalence evidence, не оценка интеллекта модели. Fixtures temp state/workspaces, no personal Trash/state/config, real daemons/GPU/channel auth не нужны.

Gates: focused/new seams; npm run lint; npm run typecheck:tests с прежними allowances и только genuine resolved debt reduction; npm run imports:check (+ self-test, если checker менялся); npm run docs:check; npm run build при изменении output/import paths; quarantine registry/self-test при relevant changes; финальный npm run test:ci. Отдельный eval typecheck нужен лишь если eval sources менялись. Фактические exits/counts/skips и найденные baseline failures записываются; skipped не считать passing.

## 6. Итоговая оценка: один фиксированный набор задач

Оценка удобства разработки внешним coding agent и оценка runtime-модели atomic-agent — разные эксперименты. Встроенный eval/ запускает CLI, а не coding agent для изменения этого репозитория. Его token columns нельзя выдавать за прочитанный Codex контекст.

До выполнения 07 зафиксировать seven task briefs и acceptance rubric, без привязки к внутренним file paths, которые сама реорганизация меняет. Каждый run в disposable checkout/state, patches не применяются к основной ветке:

1. Изменить mutable notice placement в prompt без изменения stable prefix; acceptance проверяет одинаковые prefix bytes и новый хвост.
2. Добавить файловый read-only инструмент с canonical contract, grammar/catalog/registry/classification agreement и boundary checks; exact tool brief/schema/fixtures одинаковы в паре.
3. Добавить совместимую config migration с сохранением explicit current pins; acceptance на version/null/default/freshness cases, не только lint.
4. Исправить MCP UI refresh/state/input regression в seeded fixture; acceptance rendering/event/state assertions.
5. Исправить model download resume/cancel regression в seeded fixture; fake HTTP/temporary model assets, no real download.
6. Исправить provider hot-swap/cross-transport regression в seeded fixture; live serving route/profile/parser доказаны scripted completions, no paid provider.
7. Исправить cancellation/terminal or progress regression в seeded agent fixture; exact same request, injected bug and observable expected behavior in paired variants.

Точные seeds/hidden checks готовятся перед запуском и сохраняются; затем не подгонять их по результату. Повторные same-task runs желательно не менее трёх пар при одинаковых agent/model/reasoning/tools/budgets/OS/Node/dependencies и свежей сессии без истории этой реорганизации. Порядок вариантов чередовать. One pair — только case study, не доказательство ускорения.

Сначала попытаться восстановить runnable исходную checkout до stage00 из Git history и прежних snapshots, не меняя основное рабочее дерево и protected files. Проверить, что она относится к началу программы, сохранить revision/hash. Если доступна, сравнивать с итогом07 для эффекта всей программы. Если есть только pre07, честно измерять эффект07; исторический AGENTS archive не заменяет исходный runnable code. Отсутствующий baseline или fresh coding-agent runner отмечается «не измерено» с evidence попытки, а соответствующая оценка остаётся открытой. Не запускать в текущей длинной сессии и не сравнивать её с fresh session.

На run фиксировать:

- Completion по заранее заданным independent acceptance checks: pass/fail/time budget exhausted/blocker и время до первого/финального результата; сколько проверок агент действительно выполнил корректно.
- Loaded instruction sources из actual fresh session instrumentation; code/docs read paths и уникальные возвращённые bytes плюс total bytes повторных чтений из tool transcript. rg listing не считать чтением всего matched file. Truncated output и injected automatic context отмечать separately; если доступны лишь наблюдаемые reads, так и назвать метрику, не «весь контекст модели».
- Changed files/lines, unrelated edits относительно agreed task scope, rollback/rework count и reviewer findings по severity/root cause. Review рубрика одна и до runs; version-aware hidden checks проверяют поведение, а не желаемые новые filenames.
- Run budget/model/settings/env/snapshot hashes, observable instruction-route correctness, crashes/skips и unavailable metrics. Token/cost — только из реально доступного runner accounting; не оценивать tokens делением bytes на четыре.

Report содержит per-task paired results и разброс повторов, а не только средний elapsed time/LOC. Без matched runs разрешено заключить только «границы/маршруты/эквивалентность проверены, productivity effect не измерен»; пункт сравнительной оценки остаётся незавершённым. Внешняя runtime-модель не нужна для сравнительных задач разработки: сначала использовать доступные fresh coding agents и изолированные checkouts. Не расширять refactor в ожидании измерений.

### Что доступно в существующем eval без внешней модели

В src/agent имеются scripted LLM unit/integration tests, достаточные для hermetic behavior matrix выше. eval/scripts/run-with-stub.mjs запускает canned-response llama stub: годится для проверки harness/CLI/process isolation, не agent-quality score; stub знает shipped case prompts и timings искусственные. По умолчанию судья в eval/ удалённый: с absent judge nonjudge expectations ещё исполняются, judge unavailable должен быть виден как failure/skip, а не автоматически выдан за успех. Запуск всего stub corpus не обязателен и не заменяет suite; выбрать explicit nonjudge cases только при необходимости CLI seam verification.

eval/harness/parse-trace-metrics.ts уже собирает trace availability, steps, prompt/predicted tokens, cacheHits, parse retries, loop detections, tool errors/batch sizes/tool invocation log и failure category/message; append-report-row.ts пишет CSV, append-jsonl-row.ts полные records. Эти columns применимы к runtime benchmark, не к внешнему coding-agent reading footprint. Реальные eval/cases (batching/context/instruction/recovery/coding) запускаются на одинаковом pinned endpoint/model/profile/sampling/environment лишь когда prerequisites доступны, и reported отдельно. eval-agents GAIA требует model daemon/build, dataset/auth для full corpus и возможных competitor CLIs; scoring/parsing unit tests hermetic, smoke «без HF» всё равно требует модель. GAIA/LoCoMo/modeljudge/GPU не mandatory acceptance механического 07.

## 7. Критерии принятия и честные ограничения

07 verified при выполнении всех структурных и поведенческих критериев:

- Для turn recovery, step wire/parse/repair, dispatch gates, session commit и tracker notices есть единственный актуальный owner и краткий route. Central loop/step orchestrators показывают порядок phases; contracts не зависят от implementation и нет новых cycles.
- Public exports/signatures/error identities совместимы; consumers imports intentional; runtime/session/tool/LLM/prompt behavior не изменён скрытым образом. Limits/budgets/thresholds, grammar/tool schemas/defaults/serialized state/prompt literals сохранены.
- Exact extraction evidence + semantic seam tests закрывают moved boundaries; focused и финальные gates проходят с фактическими counts. New type debt/allowance/exclusions нет; preexisting limitations перечислены.
- Guides описывают новую ownership карту, recoveries/stream-commit nuance и routes к checks, а не повторяют гигантские инструкции. Fresh route test нужен, если изменились instructions; current session evidence недостаточно.
- Итоговый report отвечает на четыре исходных вопроса: успешность same tasks, observed read context, лишние изменения, review findings. Выполненные measurements подкреплены raw evidence; отсутствие baseline/runner/model отмечено явно и не замещено утверждением «стало быстрее».
- Выполнить минимум одну matched пару fresh runs для каждого фиксированного brief и записать observed reads/лишние изменения/review findings; одна пара — case study, без статистического вывода об ускорении. Недоступные отдельные метрики не оценивать приблизительно. Roadmap07 получает verified после code gates и сравнительной оценки. Если baseline/runner действительно недоступен, сохранить конкретное ограничение и незавершённый criterion; сокращённая приёмка возможна только по явному изменению scope пользователем, не автоматически.

Рекомендация — сохранить mechanical scope и измеряемый результат. Новый универсальный retry framework и дробление каждого tracker map отвергнуты: они меняют transitions/state ownership ради формы. Недостающий full startup rollback из06, улучшение thresholds/repair behavior и реальные model-quality campaigns остаются отдельными behavioral/research tasks. Этот этап завершает организацию кода; он не обещает устранить весь технический долг или показать ускорение без эксперимента.
