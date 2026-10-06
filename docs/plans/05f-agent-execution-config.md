# Срез 05f: типы, defaults и parsing политик выполнения агента

Status: verified
Owner: repository maintainers

[Этап 05](05-config-tool-contracts.md). Создан после [приёмки 05e](../testing/stage-05e-validation.md), implementation завершена; [приёмка](../testing/stage-05f-validation.md). База: 856 diagnostics, 0 SCC/exceptions; full suite 1045/12512/4 existing skips.

## Цель и решение

Выделить agent.task (потолки задачи/autoContinue) и agent.providerWait (ожидание восстановления провайдера) как целые policy blocks с типами, созданием defaults и parsers. Это первый explicit-default pattern для дальнейшего разделения больших domains. Prompt/session budgets, read scope/approval migrations, loop/env-only поля не включать; overall agent assembly остаётся в root.

USER_CONFIG_DEFAULTS экспортирован и mutable. Cached nested constants перестали бы видеть его замену между parse calls; clone при отсутствии блока сломал бы прежнюю reference identity. Поэтому domain предоставляет fresh default factories, root вызывает их один раз при сборке своего объекта и передаёт актуальные nested defaults в parsers при каждом разборе. Leaf не импортирует schema/index и не держит скрытый singleton.

## Точный write set

Новый src/config/agent-execution-config.ts: AgentTaskConfig (maxSteps/maxDurationMs/autoContinue), ProviderWaitConfig (enabled/maxWaitMs), createAgentTaskDefaults и createProviderWaitDefaults с прежними literal values/key order/comments; parseAgentTask(raw,defaults), parseProviderWait(raw,defaults). Imports только existing error и scalar primitives. Defaults прежние: task 1000/7200000/true, wait true/300000. Parsers сохраняют bodies после удаления local root-default binding и изменения internal signature/return type; missing/null возвращает сам supplied object, present object строит fresh normalized result. Не вставлять clone/freeze/default parameter/условное пропускание validation.

Schema: четыре nested interface members ссылаются на owned types при прежней structural shape/optionality; две default literals заменяются factories на тех же positions; два parse calls передают текущий USER_CONFIG_DEFAULTS.agent.task/providerWait. Не добавлять новые names к root/config-index public exports; private parsers становятся intentional concrete-owner exports. Остальные поля/assembly/order/migrations/version/ENV_DEFAULTS/load-config/consumers byte-identical. Owned comments переносить намеренно, не копировать два набора подробных field описаний.

New agent-execution-config.test.ts закрывает missing parser/default identity gap. Integrator владеет guides/compatibility/checker/plans/evidence/snapshots; production/test write sets отдельны. Config index/agent/runtime/CLI/TUI source не меняются. No dependencies, allowances или version bump.

После extraction gate выявил изменение message fingerprints двух прежних TS2352 в providers-orchestrator.test.ts: новые имена типов отображаются в диагностике неполных config casts. Отдельная корректировка acceptance scope: заменить ровно две incomplete full-config fixtures настоящей полной test-isolated конфигурацией с прежними overrides; убрать casts вместо обновления allowances или сужения claimed contract. Затем reduce только эти два реально устранённых diagnostics. Production TUI остаётся неизменной. Зафиксировать fixture/debt diff отдельно от extraction proof.

## Матрица поведения и доказательства

После verified 05e snapshot source/protected/debt/public types/defaults/order и actual raw-policy outputs/errors/references. Missing/undefined/null policy возвращает текущий default object по ссылке; два absent parses share его. Present {} даёт fresh object с текущими значениями; scalar null использует ?? fallback, false остаётся explicit. Property mutation, замена nested default и whole agent default между calls должны наблюдаться следующим parse; старые results сохраняют прежние ссылки. Factory calls дают fresh mutable объекты прежнего shape/key order. В mutation tests обязательный finally restore всех изменённых defaults.

Сохранить numeric-string/bool semantics и exact error fields/messages: whole arrays/nonobjects rejected; нулевые ceilings rejected даже при disabled wait; unknown present-object fields discarded. Не добавлять task.maxSteps versus agent.maxSteps clamp в config: runtime применяет свою policy позже. Class/Date objects не ужесточать до plain objects. Не capture USER_CONFIG_DEFAULTS.agent раньше нужного call: raw/default evaluation order остаётся прежним.

Proof намеренно допускает private signature, type aliases, factory construction и explicit-dependency transformations; не заявлять byte-identical mechanical move. Сравнить normalization bodies после ровно этих правок, factory return literals с прежними values/order, expanded public structural properties (AST alias expansion или TypeScript checker), root public names/default/version/prompt/protected и остальные source bytes. Никаких fallback aliases для ослабления проверки identity.

## Проверки и завершение

Existing config/schema/file/load/agents-md-defaults и CLI config-command seams; новые purposeful normalization/default-reference tests. Downstream agent-loop/provider-wait/task ceiling, agent-loop-stop-cause/segmentation/request-deadline, request-deadline, CLI run-agent и TUI outage/args checks по actual touched interface. Lint/types (no new debt)/imports (0 SCC/exceptions)/docs/diff/build/quarantine и full test:ci. При изменении boundary — предварительный negative и positive source fixtures, including types; owner→root prohibited. Записать фактическую приёмку; затем specified следующий meaningful domain (кандидат web search/fetch с сохранением validation order), а не whole-config rewrite.

Этот срез не завершает весь 05, не меняет runtime algorithms/override priorities и не начинает этапы runtime/agent-loop. User JSON, default значения и reference behavior должны сохраниться.


## Фактическая приёмка

[Доказательства и ограничения](../testing/stage-05f-validation.md): 1046 suites / 12530 passed / 4 existing skips, 854 diagnostics после двух real fixture fixes, no new errors; 0 SCC/exceptions; lint/build/docs/proofs passed. Schema 5463 → 5365. 05f verified, overall 05 in-progress; следующий [05g web configuration](05g-web-config.md) specified после этой приёмки.
