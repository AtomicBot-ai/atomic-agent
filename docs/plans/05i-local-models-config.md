# Срез 05i: весь домен конфигурации localModels

Status: verified
Owner: repository maintainers

[Этап 05](05-config-tool-contracts.md). Создан после [приёмки 05h](../testing/stage-05h-validation.md); [Приёмка 05i](../testing/stage-05i-validation.md) завершена; следующий [05j](05j-frontend-integration-config.md) specified. База: 854 explicit test type diagnostics, 0 runtime cycles/exceptions, full runner 1048 suites / 12604 passed / 4 existing skips. Независимое исследование source определило границы ниже; перед writes нужен новый acceptance snapshot, прежние research captures его не заменяют.

## Цель и граница

Перенести весь localModels configuration domain: два разных user/runtime shapes, пять существующих named types, defaults, семь public validators, domain migrations и раннюю/позднюю normalization. Это один domain, без отдельных этапов для каждого флага. Каталог src/config/local-models/ разделяет типы, default construction и parser; обязательного index.ts нет. По нынешнему source root освободится примерно от 650–750 строк, но это оценка размера, не обещание ускорения агента.

Runtime shape содержит env/bootstrap values, timeouts, slot/API settings; user shape содержит customModels. Их нельзя объединить в один сокращённый interface, Omit или mapped type при механическом переносе. Root остаётся владельцем version acceptance, unknown top-level keys, whole-config assembly и cross-domain LLM registry composition.

Не меняются local-LLM lifecycle, backend selection, download implementation, catalog registry, environment precedence, loadConfig side effects, credentials, CLI/TUI persistence, public imports или конфигурационная политика. Не запускать model/server/download network jobs для проверки этого переноса.

## Точный production write set

1. src/config/config-schema.ts.
2. Новый src/config/local-models/local-models-types.ts.
3. Новый src/config/local-models/local-models-defaults.ts.
4. Новый src/config/local-models/local-models-parser.ts.

Types owner:

- RuntimeLocalModelsConfig — ordered literal из AtomicAgentConfig.localModels; UserLocalModelsConfig — отдельный ordered literal из UserConfigFile.localModels.
- Existing public LocalLlmMode, LocalTemplateSetting, UserManagedLocalLlmConfig, LocalModelDownloadConfig, UserManagedEmbeddingLlmConfig с прежними names/unions/property types/order/comments.
- Только type imports существующих LocalModelDef, BackendVariantPreference, SwaFullPreference из concrete catalog/backend/server modules. Эти neutral/concrete modules не переносить. Все paths относительно нового каталога — ../../local-llm/… .

Defaults owner:

- createLocalModelsDefaults(): UserLocalModelsConfig возвращает прежний literal USER_CONFIG_DEFAULTS.localModels с exact values/order/comments, fresh nested objects и отдельными fresh tensorSplit/customModels arrays.
- Type-only import своего types owner; runtime imports только DEFAULT_DOWNLOAD_CONNECTIONS и DEFAULT_HF_ENDPOINT из существующих concrete modules.
- Никаких resolve configured/environment functions, cache/freeze или shared object. Root вызывает factory один раз на прежнем месте defaults.localModels.

Parser owner:

- Сохранить public signatures/bodies семи функций: parseLocalTemplateSetting, parseLocalLlmMode, parseBackendVariant, parseSwaFullPreference, parseLocalCompletionCap, parseReasoningBudgetTokens, parseTensorSplit.
- Перенести private parseOptionalManagedModelId, resolveManagedParallel, resolveManagedAutoUpdate, resolveEmbeddingModelId и parseHfEndpoint; constants UNCHOSEN_PARALLEL=2, AUTO_PARALLEL_VERSION=63 и MANAGED_AUTO_UPDATE_DEFAULTS_VERSION=41 с принадлежащими комментариями.
- prepareLocalModelsInputs(raw: Record<string, unknown>, inputVersion: number, readDefaults: () => UserLocalModelsConfig): PreparedLocalModelsInputs переносит нынешний contiguous early region — customModels, managed, embeddings, download, mode, url. Retain original raw reference для late fields.
- parseUserLocalModelsConfig(prepared, readDefaults: () => UserLocalModelsConfig): UserLocalModelsConfig переносит прежний late localModels literal. Prepared shape содержит raw/customModels/managed/embeddings/download/mode/url; этот API внутренний, не root/index public export.
- Добавить default thunk только private helpers, которым нужен прежний USER_CONFIG_DEFAULTS lookup. Чтение остаётся внутри исходного branch, а не заранее вычисленным argument.

Root заменяет два nested type literals owner aliases, imports used type/parser/factory names и совместимо re-exports прежние пять types + семь functions. Новые RuntimeLocalModelsConfig/UserLocalModelsConfig/internal functions не добавлять в root public API. config/index.ts byte-identical. Старые imports удалять только после proof фактических remaining references; не удалять compatibility re-exports.

Other production, existing tests и protected files byte-identical. Test agent может добавить один новый src/config/local-models/local-models-config.test.ts; integrator отдельно владеет README/guides/plans/evidence/checker policy/negative fixtures. Никаких новых dependencies, debt allowances, version bump или изменений algorithms.

## Главное: сохранить две фазы и cross-domain LLM seam

Сейчас root готовит все raw blocks, включая retained memory references, и валидирует webhooks раньше localModels. Далее localModels выполняется так:

1. parseCustomLocalModels(raw.customModels), до managed.modelId. Файл может одновременно добавить custom model и выбрать его; lookup идёт по parsed same-file array, а не по registry, который публикует loadConfig позднее.
2. rawManaged normalization; ordered managed object: modelId, port, dataDirOverride, autoUpdate, stopOnExit, autoRestart, device, backendVariant, contextSize, tensorSplit, parallel, swaFull.
3. rawEmbeddings normalization; embeddingsPort проверяется отдельно ДО enabled. Затем ordered embedding object: enabled, modelId, captured port, url.
4. rawDownload normalization; connections, hfEndpoint.
5. mode, затем url.
6. Root собирает/проверяет llmBlock через parseUserLlmFileConfig, используя captured mode/managed.port/localModelsUrl/embeddingsDaemon.url.
7. Уже в return после unknownTopLevelKeys и output version выполняется late localModels object: captured url/mode, completionMaxTokens, useServerTemplate, thinking, reasoningBudgetTokens, captured managed/embeddings/download/customModels.
8. Затем log/agent и все остальные domains в прежнем порядке.

Нельзя объединить full normalization в один ранний вызов: invalid late completion cap сегодня уступает invalid LLM provider, а ранний managed/embedding/download дефект опережает LLM и поздние поля. Нельзя переставить embedding port внутрь object по key order: precedence port vs enabled изменится. Root сохраняет llmBlock literal и positional execution seam, обращаясь к prepared values; LLM owner не импортирует localModels parser и наоборот.

## Default lookup и actual migrations

readDefaults() вызывается отдельно в каждом прежнем fallback выражении, с тем же short circuit и повторными raw accesses. Не capture defaults/localModels.managed once, не destructure defaults. Raw/default getters могут заменить nested/whole defaults внутри вызова. rawManaged.dataDirOverride сохраняет repeated reads; отсутствие даёт null без default lookup.

resolveManagedParallel: literal "auto" возвращается до default read; absent/null читает нынешний managed.parallel непосредственно, без валидации default; остальные значения bounded 1..8; только pre-v63 pinned 2 становится "auto". Другие operator pins сохраняются, v63+ 2 остаётся 2.

resolveManagedAutoUpdate: pre-v41 сразу true, игнорируя malformed raw и НЕ читая defaults; v41+ parseBool(raw ?? current managed.autoUpdate). Не передавать default value eager argument, даже если JSON outputs совпадут.

resolveEmbeddingModelId: _inputVersion сейчас не используется. Present non-null value проверяется только parseNonEmptyString; unknown nonempty ID принимается. Absent/null берёт нынешний embeddings.modelId напрямую. Не восстанавливать из historical comments pre-v22 forcing или каталог embedding-ID validation.

Tensor split всегда parseTensorSplit(rawManaged.tensorSplit), без fallback к default tensorSplit. customModels всегда parseCustomLocalModels(raw.customModels), без fallback к default customModels. Embedding URL при отсутствии выводится из фактически проверенного embedding port, а не из USER_CONFIG_DEFAULTS.localModels.embeddings.url. Все эти исключения нужно сохранить при whole-default replacement captures.

User default values exact: url http://127.0.0.1:8080; mode external; completionMaxTokens 16384; template/thinking auto; reasoningBudgetTokens 1500; managed modelId/dataDirOverride null, port19091, autoUpdate/stopOnExit/autoRestart true, device/backendVariant/swaFull auto, contextSize0, tensorSplit[], parallel auto; embedding enabled false/modelId null/port19092/url http://127.0.0.1:19092; download existing constants; customModels[]. Документация owner не должна стать вторым вручную синхронизируемым источником этих значений.

## Preserved validators и permissive behavior

- completion cap accepts 0 or 64..131072; reasoning budget 0 or 64..32768, existing integer/string coercion и exact errors.
- mode/template/backend/SWA case sensitivity unchanged; backend/SWA accepted values берутся из текущих concrete owner constants/predicates.
- managed modelId проверяется по known catalog либо same-file customModels; отсутствие даёт null. custom parser ordering/errors сохраняются.
- contextSize nonnegative; port positive без нового ceiling65535; device использует прежний nonempty string validator без trimming policy; dataDirOverride не получает filesystem/executable checks.
- tensorSplit absent/null/empty даёт fresh []; single entry запрещён; finite numeric entries >=0, хотя бы один >0; numeric strings, sparse undefined, infinities rejected. Не заменять existing implementation JSON Schema policy.
- local URL использует прежний general parseUrl: accepted schemes/original bytes не ужесточать до HTTP(S). Runtime guards отдельно.
- HF endpoint использует существующий normalizeHuggingFaceEndpoint: trims input/trailing slash, accepts HTTP(S), preserves path prefix, strips credentials/query/fragment by returned protocol/host/path. Despite "origin" comment, path accepted; не исправлять helper/политику в mechanical slice.
- Download connections current1..MAX_DOWNLOAD_CONNECTIONS64. External mode/disabled embedding daemon продолжают валидировать managed/embedding/download fields.
- Raw whole/subblock casts и ??{} permissiveness остаются прежними, без новой strict object-only проверки или unknown nested key preservation.

Comments ownership: embedding lifecycle JSDoc сейчас misplaced непосредственно перед download JSDoc; перенести его к UserManagedEmbeddingLlmConfig, download-only к LocalModelDownloadConfig. Перед parseLocalCompletionCap находятся два JSDocs: первый generic bounded-positive comment остался orphan от 05a и должен остаться в root (не объявлять новым localModels-owned правилом); переносится только собственный local-cap comment. Перед parseHfEndpoint стоит JSDoc общего parseUserConfigFile/forward compatibility — его оставить в root у общего parser, не переносить к HF validator. Любые остальные adjacent comments оставить до явного owner proof.

## Allowed dependencies / import checks

Parser runtime imports existing ConfigValidationError, concrete config primitives/parseUrl, parseCustomLocalModels, isKnownLocalModelId, backend/SWA predicates+constants, MAX_DOWNLOAD_CONNECTIONS, normalizeHuggingFaceEndpoint; type imports собственных shapes и catalog/backend/server types где реально нужны. Нет imports composing config-schema/config/index, loadConfig, runtime/TUI/server manager/download execution. Source catalog намеренно не импортирует config-schema (см. registry documentation); current graph это подтверждает. Module dependencies не означают запуск probes/network: parser вызывает только перечисленные pure helpers.

Types own dependencies только type-only. Defaults imports constant owners непосредственно, parser imports concrete helpers; graph 0 runtime SCC/ownership exceptions. Checker разрешает этот реальный DAG, без искусственного запрета всех внешних domain imports и без исключений. Добавить bounded positive/negative static/type/dynamic fixtures по новым owner roles, не blanket allow каталога.

## Fresh baseline и доказательства

До production writes снять full src/protected/package/compiler/debt/default/version/export snapshots после verified05h. Actual old graph запускается из immutable snapshot с temporary node_modules symlink и tsx; fixtures/artifacts вне repository. Сравнить whole-root output/error/default/ENV_DEFAULTS/export matrices до/после, а также direct seven helper outputs/errors/function identity, восстановив каждую mutation в finally.

Behavior matrix:

- Все accepted old/future versions и отказ неподдерживаемых; targeted40/41 и62/63 boundary, versions around embeddings introduction/current — actual source, без assumed migration.
- Missing/null/default/explicit values; mode external/managed; add+select custom model samefile; unknown managed vs accepted unknown embedding ID; exact errors и class identity.
- completion/reasoning zero/bounds/coercion; template/backend/SWA; tensor split valid/invalid/sparse/fresh arrays; download connection bounds; HF origin/path/whitespace/credentials/query normalization; arbitrary general URL scheme.
- Multi-invalid precedence customModels→managed→embedding port→enabled→download→mode→url→LLM→late four fields→log/agent/memory. Pair with earlier webhook error and later memory error.
- Raw/default Proxy event arrays, repeated dataDirOverride accesses, early retained managed/embed/download outputs и late raw scalar read; within-call nested/whole localModels default replacement; pre41 no autoUpdate default read; explicit parallel auto no default read; absent parallel/default and embedding ID direct-return behavior; derived embedding URL independent from mutated default URL; mutated tensorSplit/customModels default ignored.
- Fresh factory and parsed objects/arrays across calls; exact property order; old results unchanged after defaults replacement.

Source proof: exact seven signatures/bodies/constants/unions, private bodies modulo recorded default-thunk substitutions, expanded runtime/user ordered type shapes/comments, original default literal, contiguous early region и late literal modulo recorded prepared names/default-thunk substitutions. Whole other root text unchanged, direct cross-domain llmBlock literal unchanged except named captured references; config/index/load-config/concrete helpers/consumers byte-identical. Verify import/export public list independently; module facade functions preserve same reference as owned functions. No whole-parser byte-identity claim.

## Проверки

New meaningful domain tests покрывают phase/migration/default/factory seams; существующие scalar tests не дублировать exhaustive mirrors. Focused existing: config-schema, custom-models-schema, llm-config, load-config, config-file, agents-md-defaults; CLI config-command/model command/download/search/handler seams; TUI persist-user-local-models-config. Static behavior consumers: local-llm catalog/HF, backend variant, SWA, daemon lifecycle/launch guard; LLM server-template-policy/reasoning-budget/model-profile and corresponding agent profile tests when selected based on actual imports.

Integrator: lint, test type gate (854 previous diagnostics unless genuine fixes separately explained/reduced), import check/self-tests with0SCC/exceptions, docs, protected/source/API/default proof, build, quarantine check, full test:ci. Captures/selected focused tests do not replace integrated checks. Existing test assertions stay unchanged. JSDoc source inventory может быть дополнен новым types owner по примеру 05h, только с сохранением regex/judge/floors/allowlists и negative proof; реальные fixture fixes обосновывать отдельно.

## Остальная часть05: конечные смысловые группы

После full localModels не следует делать десятки toggle slices. По нынешнему root остаются coherent groups: (1) frontend/channel/integration settings — TUI/onboarding/notify, Telegram/Discord/swarm/notifications/atomic-mail/composio/git с собственными владельцами и disjoint parallel writes, один root integrator; (2) оставшиеся execution/tool/security/session settings — общий agent budgets/approval/readScope/http/shell/session retention/tracing/skills, с preservation cross-domain/migration seams, root оставляет version/assembly; (3) tool-contract coverage/conformance — hash prototype уже выполнен, следующий bounded family и общий consistency gate по фактически известным descriptor/schema/parser/class/role exceptions; (4) общая приёмка05/public API/migrations/navigation.

Это направления оставшейся программы, не уже готовые numbered plans и не требование вынести все root types. Определять точные groups/write sets после preceding verification; не дробить по line count, не обещать wall-clock срок заранее. Root intentionally может остаться заметным файлом assembly. Этап05 завершён только после общей приёмки config owners и согласованности выбранных tool contracts, затем план06 runtime и07 agent-loop; не начинать их под видом завершения05.


Уточнение acceptance scope: named type extraction изменил порядок union в уже известной TS2741 diagnostic model-strict-tools.test.ts. Исправить только missing kind:chat в одном contextual userModels fixture; existing assertions/behavior unchanged. Reduce только фактически исчезнувшую diagnostic, без добавления/замены fingerprints; compiler/gate unchanged.
