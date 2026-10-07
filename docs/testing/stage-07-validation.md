# Приёмка 07: цикл агента и сравнительные задачи

Status: verified
Owner: src/agent/ and repository maintainers

Проверяется [план07](../plans/07-agent-cycle-evaluation.md). Код интегрирован и прошёл финальные gates; matched evaluation выполнена по [заранее сохранённым briefs](stage-07-task-briefs.md). Это последний этап общего маршрута. Verified опирается на code gates и все14 сравнительных запусков, а не только на зелёный CI.

## Результат и механизм

AgentLoop сохраняет orchestration и исходные await points вокруг синхронной подготовки, решений восстановления и завершения turn. Его mutable counters/retry state имеют одного владельца. executeStep показывает подготовку запроса → completion → синхронный parse/repair → admission → batch → ordered commit. Единственный исходный await repair остаётся в оркестраторе; streamed parser/iterator cleanup остаются в inference owner.

Batch scheduler и synchronous gates отделены от compatibility facade. ToolLoopTracker сохраняет единое состояние; fingerprints/notices/constants и observation helpers отделены от него. Existing plan/fusion/evidence/tool-set policies и recovery leaves перенесены с тестами; девять policy/recovery и четыре progress root paths остаются named-export facades. Contract owners содержат type-only зависимости. Потребители используют явные contracts вместо загрузки больших executors ради типов.

Generic retry framework и дробление каждого tracker counter в service-object отвергнуты: они изменили бы переходы и ownership ресурсов ради формы. Параллельные исполнители правили независимые новые owners; старые orchestrators и consumers интегрировал один агент.

## Эквивалентность и реальные ошибки при переносе

[Source evidence](evidence/stage07/source-evidence.json) фиксирует 19 проверок: 18 прежних модулей, 158 runtime exports и 240 TypeScript signatures совместимы; семь extraction/relocation proofs проходят. 2512 исходных файлов из pre07 snapshot остались побайтово прежними; согласованные изменения ограничены owners, совместимыми facades, imports и tests. Конфигурация, prompt/grammar/schema literals, package/lock/compiler, type debt и quarantine не менялись. 24812 защищённых файлов и EVIDENCE_ROUTER_MODEL.md совпадают с отдельно сохранёнными hashes05j; это не выдаётся за новый pre07 capture.

Два новых unconditional async wrappers первоначально добавили microtask перед dispatch и перед failure footer/steering closure. Actual old/new graph captures воспроизвели разницу; wrappers заменены синхронными recipes вокруг прежних await. [Parse order](evidence/stage07/parse-event-order.json) и [recovery order](evidence/stage07/recovery-event-order.json) теперь совпадают. Meaningful seam tests проверяют также repaired path, cancellation и callback order. Ошибки новых fixtures (поле времени, unsupported matcher, отсутствующий fifth argument, ошибочное result.error) исправлены по реальным contracts, без casts/allowances.

Standalone differential первый раз запущен без isolated state env и остановился на EPERM при попытке записать personal config temporary file; записи не произошло. Успешное evidence получено только с отдельным ATOMIC_AGENT_STATE_DIR. Vitest использует существующую изоляцию fixtures. Этот неуспешный запуск не считается proof.

## Проверки

- [Final CI](evidence/stage07/test-ci.txt):1084 suites,12955 passed,4 existing skips. Full run выполнен с local loopback доступом; sandbox focused run имел800 passed и4 listen EPERM, что не считалось успешной проверкой этих четырёх сценариев.
- Production lint и [build](evidence/stage07/build.txt) проходят; [test types](evidence/stage07/test-types.txt):2499 roots/105TSX/848 explicit debt/no new errors.
- imports:1435 modules/5342 local edges/0 runtime cycles/0 exceptions; [self-test](evidence/stage07/import-selftests.txt):242 fixtures pass.
- docs:244 active files/19 instructions, max chain8093/24576 bytes, links/metadata/pointers/archive coverage pass до добавления отчёта. [Observer self-test](fixtures/stage07-read-observer.selftest.mjs) проверяет actual read/search byte spans и path/log confinement.
- git diff --check проходит. AgentLoop3193→870 строк; step-executor3873→265; batch-executor1037→3; tracker1522→749. Это organization metrics, не доказательство ускорения.

[Portable source verifier](fixtures/stage07-source-proof.mjs) принимает независимый pre07 snapshot и session manifests через --baseline/--proof-dir. Он не генерирует baseline из текущих файлов и не заменяет behavioral tests. Raw source capture сохраняет реальные paths/check hashes; для повторения extraction proof нужны его исходные session inputs, находящиеся вне репозитория.

## Сравнительная оценка

Выполнены семь matched pairs fresh coding agents, fork_turns=none, без model/reasoning overrides, в отдельных seeded copies исходного cce6262c и final-v2. Им выданы одинаковые briefs и инструментированный маршрут чтения. Проверочный harness/seed manifests/golden недоступны исполнителям; positive/negative controls и checks SHA зафиксированы до runs.

Одна пара на задачу — case study. Exact backend model ID, общий token/cost accounting и автоматически внедрённый context runner не предоставил. [Observer](fixtures/stage07-read-observer.mjs) измеряет byte ranges read/search excerpts, выданные в stdout: versioned unique source bytes, repeated bytes и instruction/code split. Дополнительная обрезка tool transport не наблюдаема; эти bytes не равны гарантированно полученному моделью контексту. Test output, operator prompt и автоматический context не входят в эти bytes. Elapsed time не используется как причинное доказательство ускорения.

[Paired results](evidence/stage07/paired-results.json) содержат actual frozen acceptance, наблюдение, изменённые файлы, findings и limits для каждого run. [Freeze](evidence/stage07/benchmark-freeze.json) фиксирует positive/negative controls до выдачи задач: original cce6262c, final-v2; check SHA256 `5b2eda192c3d4bee3a373069da07c20ff75ccdce23233d8cc84b3448b16d1f37` сохранён без изменений. Все14 свежих исполнителей завершили задачи в заданном бюджете; отзывы проверены по actual diffs и независимому harness. Из эксперимента ничего не перенесено в продукт.

Per-task результаты (original → final; versioned unique source output bytes):

1. Prompt: PASS → PASS;110123 →67356.
2. Read-only tool: FAIL → FAIL;170198 →169556.
3. Legacy migration: PASS → PASS;89082 →82306.
4. MCP refresh: PASS → PASS;74054 →53790.
5. Resume download: PASS → PASS;110513 →57840.
6. Provider vision: PASS → PASS;144826 →105198.
7. Serial cancellation: PASS → PASS;108883 →88203.

Суммарная successful acceptance одинаковая:6/7 против6/7. Сумма versioned unique source output по семи tasks:807679 →624249 bytes (−22.7%); instruction output354019 →63201; repeated output67905 →13607. Это измерение выдачи observer для конкретных runs. Оно не измеряет всю prompt/context загрузку, tokens, cost или latency и не доказывает статистическое ускорение/рост успешности. Отдельные agent checks имели различный scope; scored acceptance одинаковая.

Review выполнено integrator по сохранённым diffs с одинаковыми критериями correctness, invariants, unrelated edits и API scope. Лишних изменений вне задачи не найдено в обоих вариантах. Frozen task2 упал у обоих на `path="   "`: check требует отклонять пробельный путь, parser проверяет length>0. Brief не определил trim, а whitespace-only filename законен. Результат сохранён какFAIL, неоднозначность evaluator не скрыта и не пересчитана после результата. Последующие assertions этого check после первого failure не объявляются выполненными. Test-fixture finding у final provider task: новый `vision-model-overrides.test.ts` использует `as never` для dependency stubs, ослабляя type verification; production fix проходит harness. В original подобного нового bypass не найдено. Эти экспериментальные patches остаются в disposable copies.

Scaffold limitations: копии имели source/docs/grammars/config/scripts, но не все licensing/eval/release fixtures; дополнительный docs:check у final prompt/tool остановился на отсутствующих LICENSE, eval document и workflow. Selected SQLite suites у четырёх runs столкнулись с Node26/native ABI141→147; tool-final и provider-original повторили их на Node25.7, MCP-original и provider-final оставили дополнительные HTTP/full-runtime suites непроверенными. Независимые acceptance checks выполнены одинаковым Node25.7. Эти ограничения отдельно записаны и не смешиваются с product CI.

Raw observer logs, prompts, seeded diffs, manifests и acceptance для каждого run сохранены в evidence/stage07/runs. Все исполнители сообщили, что намеренные чтения проекта шли через observer; это declaration, не доказательство отсутствия автоматической загрузки или ненаблюдаемых transport truncations. Model/settings inherited без overrides; точный backend ID и общий accounting runner не раскрывает. Один reviewer и одна пара на task ограничивают обобщение. Измерений недостаточно для утверждения, что качество правок улучшилось: successful tasks одинаковы, а final имеет одну fixture finding.

Старый большой guide сохранён; archive не входит в обязательный маршрут. Старый типовой долг848 и4 skips остаются. GPU/live-provider/model-quality eval, startup rollback/grammar lifecycle follow-ups и дальнейшее изменение recovery thresholds остаются отдельными задачами. Восьмиэтапная программа реорганизации завершена; новые behavioral/research улучшения не продлевают её.
