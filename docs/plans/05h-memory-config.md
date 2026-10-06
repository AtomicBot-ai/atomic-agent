# Срез 05h: весь домен конфигурации памяти

Status: verified
Owner: repository maintainers

[Этап 05](05-config-tool-contracts.md). Создан после [приёмки 05g](../testing/stage-05g-validation.md); [Приёмка 05h](../testing/stage-05h-validation.md) завершена; следующий [05i](05i-local-models-config.md) specified. База: 854 explicit diagnostics, 0 runtime SCC/exceptions, full runner 1047 suites / 12564 passed / 4 existing skips.

## Цель и размер среза

Перенести весь memory configuration domain одним согласованным изменением: types/default construction, раннюю подготовку raw references, позднюю normalization и принадлежащие памяти version helpers. Все 15 блоков перемещаются вместе: profile/reflection/notes/recallInjection/index/dedup/eviction/embeddings/links/evolution/lessons/procedures/consolidation/voting/retrieve. Включены reflection.typedNotes/anySpeaker/segmentation и retrieve.rewriter.embeddingGate. Не создавать отдельные numbered slices для каждого toggle.

Сейчас два type members занимают около 584 строк, defaults 154, late normalization 433, плюс raw preparation и helper. Это единая ответственность config validation, но не повод собрать новый файл на 1200 строк. Согласованный каталог src/config/memory/ разделяет types, default construction и parsing без обязательного index.ts. Ожидаемое уменьшение root около 1200 строк — ориентир по source, не доказательство эффективности агента.

Memory stores, reflection/retrieval, providers, prompt formation и runtime algorithms сохраняют прежних владельцев и bytes. Сборка всего config, acceptance versions, unknown top-level keys и междоменные политики остаются в root.

## Точный write set и API

Production: src/config/config-schema.ts и три новых concrete owners:

- src/config/memory/memory-types.ts: RuntimeMemoryConfig и UserMemoryConfig из прежних nested literals, RewriterGateMode из прежней union. Ни одной runtime/source зависимости. Shapes структурно равны, но порядок reflection.segmentation/anySpeaker у runtime/user различается; оба ordered declarations и все type/member comments сохраняются. Не вводить mapped/Omit types или новую readonly/optional семантику ради сокращения этого переноса.
- src/config/memory/memory-defaults.ts: createMemoryDefaults():UserMemoryConfig возвращает прежний memory literal, с exact values/key order/comments и fresh mutable вложенными объектами. Type-only import собственного types owner; no cache/freeze. Root вызывает factory один раз на прежнем месте USER_CONFIG_DEFAULTS.memory.
- src/config/memory/memory-parser.ts: PreparedMemoryInputs, prepareMemoryInputs(raw), parseMemoryConfig(prepared,inputVersion,readDefaults:()=>UserMemoryConfig); прежний public parseRewriterGateMode с exact body; private MEMORY_V2_OPT_IN_DEFAULTS_VERSION=22/parseMemoryV2FeatureEnabled с прежней branch/body/signature. Type-only зависимости на собственные types, runtime imports только concrete error/scalar/value/subcall-timeout owners.

Root использует два owned memory types вместо nested literals и сохраняет прежние public RewriterGateMode/parseRewriterGateMode exports. Новые имена не добавляются в root/config-index public API. В early region остаётся memory=(obj.memory as Record|undefined)??{}, contiguous subblock reads заменяются prepareMemoryInputs. В прежнем late месте memory становится parseMemoryConfig(preparedMemory,version,()=>USER_CONFIG_DEFAULTS.memory).

Переносятся только owned declarations/comments. Не захватывать соседние orphan comments. Удалить лишь ставшие unused root import bindings, сохранив public re-exports. subcall-timeout-migration.ts и его constants/functions/tests byte-identical; root import может уйти только когда больше не используется.

Test agent: один новый src/config/memory/memory-config.test.ts для domain seams. Integrator: новый английский README каталога, config guides/compatibility, границы импортов, plans/evidence/snapshots/proofs. Existing test bodies/expectations не переписывать. Config/index/load-config/consumers/localModels default-model migrations сохраняются. No dependencies/allowances/version bump/algorithm changes.

## Порядок чтения и миграции

prepareMemoryInputs читает нынешние raw subblocks/nested subblocks по прежнему порядку и casts/??{}, после web/tracing raw inputs и до webhook/localModels normalization. В нём нет validation/default lookup/clone/freeze/eager scalar reading. References удерживаются до позднего разбора. parseMemoryConfig выполняет прежний ordered memory literal после sessions.retention/tracing и до vision/skills/TUI/channels.

Каждое прежнее fallback expression отдельно получает current default через thunk. Нельзя capture nested defaults или один раз destructure их значения: raw/default getters могут заменить memory defaults внутри вызова. Сохранить short-circuiting, повторные nested raw accesses и ранние retained references.

Для семи v22 enabled helper calls — links/evolution/lessons/procedures/consolidation/voting/retrieve.rewriter — default argument читался безусловно до вызова helper, даже когда pre-v22 branch возвращал true. Это чтение остаётся аргументом в прежнем месте. До v22 raw false/invalid игнорируется; с v22 raw??current default валидируется. Не распространять эту миграцию на другие enabled fields и не подменять inputVersion текущей output version.

Для reflection/link-generator/rewriter timeout scalar parser работает до shared v65 migration helper. Точный old default 10s/8s/3s у pre-v65 файлов заменяется текущим, отличающийся операторский pin сохраняется. Current nested default читается снова для resolveSubcallTimeoutMs, даже при explicit raw timeout. Не схлопывать повторные reads; absence сначала получает нынешний default как прежде. PRE_V65_SUBCALL_TIMEOUT_DEFAULTS остаётся прежним объектом shared owner.

## Контракты и доказательства

Перед writes — fresh full src/scripts/docs/package/compiler/debt/protected snapshot после verified 05g. Research captures не являются acceptance baseline. Полные defaults/ENV_DEFAULTS/version/runtime exports/user/runtime shapes и остальные source bytes сохраняются.

Before/after matrix: все поддерживаемые versions/future refusal, boundaries 21/22 и 64/65, explicit false/malformed old feature flags, absent/current/old/custom subcall timeouts, bool/numeric/null/list/default semantics и exact error class/field/reason/message. Disabled subsystems продолжают валидировать остальные fields. Не вводить plain-object restriction, sum-of-weights normalization, capacity clamp, exemplar dedup или новые migrations из исторических текстов.

Сохранить нынешние zero allowances и bounds: reflection.maxNotesPerCall/recallInjection.k/index.limit/voting.eventLogMaxRows nonnegative, profile.maxEntries и прежние остальные positive ceilings, weights [0,1], signalDecay (0,1]. Exemplars сохраняют parseStringArrayOrNull semantics. Whole/subblock primitive/array/class inputs используют нынешние permissive casts; fresh outputs/ordered nested keys и discarded unknown fields прежние.

Отдельные invalid pairs webhooks/localModels/agent/http/search/tracing/memory/vision закрепляют precedence. Getter captures проверяют early subblock ordering, default reads, within-call nested/whole-memory replacement, unconditional v22 arguments и repeated v65 reads. Все mutations восстановить в finally.

Source proof сравнивает exact gate-mode type/parser и feature helper/constant, раскрытые два ordered public memory types, fresh default literal/order/comments, early raw sequence и late object expressions после recorded prepared-name/default-thunk substitutions. Весь другой root text и production source byte-identical. Private interfaces/construction меняются намеренно; whole-parser byte identity не заявлять. У всех owners explicit inward dependencies; types не импортируют source, defaults зависят лишь от types, parser — от types и concrete scalar/value/error/shared migration. Предварительные negative/positive static/type/dynamic fixtures, no exceptions.

## Проверки и приёмка

Новый meaningful suite закрывает фазовые/default/version seams и nested factory/output freshness; не зеркалить все scalar tests. Existing config/schema/file/load/agents-md-defaults/subcall-timeout-migration и CLI config-command seams. Relevant downstream: memory profile/context/reflection/query-rewriter/link-generator и associated retrieval/formation suites; agent segmentation/reflection-fire-safety/profile-clip и prompt build. Runtime source не меняется, paid/GPU eval для этого переноса не требуется.

Lint, test type gate без новых ошибок, imports 0 SCC/exceptions, docs/diff/quarantine/build, затронутые checker self-tests и integrated full test:ci. Если named type rendering выявит прежние incomplete fixtures, отдельно обосновать реальное исправление и reduce только устранённые diagnostics; allowances/fingerprints не обновлять ради зелёного gate. После фактической evidence отметить 05h verified, затем уточнить следующий цельный domain по состоянию source.

## Как завершать оставшуюся часть 05

Оставшуюся работу группировать по ответственности: full memory; full localModels types/default/migration/parser; согласованные frontend/channel/integration config owners с параллельными disjoint writes и единым root integrator; итоговая проверка migration assembly/public API и расширения выбранных tool contracts. Это направления, а не дополнительные detailed plans до приёмки предыдущего среза. Не требуется выносить каждую root declaration: root намеренно владеет assembly/version acceptance/cross-domain policy. Весь 05 ещё in-progress; runtime 06 и agent-loop 07 не начинаются до его общей приёмки. Monorepo/packages не входят в программу.


Уточнение при сверке с baseline перед переносом: profile.maxEntries требует positive integer и отвергает 0. Прежняя запись плана о nonnegative была ошибочна; сохраняется actual source behavior, без расширения accepted inputs.


Уточнение acceptance scope после интеграции: existing agents-md-defaults.test.ts сканировал JSDoc только в config-schema.ts и потерял перемещённые claims (1 вместо minimum 23). Обновить только source inventory/collector file labels для actual schema owners, сохранив regex/judge/floors/allowlists/assertions; negative temporary JSDoc mutation должен по-прежнему вызывать отказ. Это adaptation проверки к новому расположению, не изменение defaults или ослабление coverage.
